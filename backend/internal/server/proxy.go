package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kyle/recipepwa/backend/internal/db"
)

const (
	proxyMaxBody      = 5 << 20 // 5 MB
	proxyMaxURL       = 2048
	proxyRateLimit    = 10 // requests per minute per user
	proxyRateWindow   = time.Minute
	llmMaxRequestBody = 200 << 10 // 200 KB
)

var (
	proxyTimeout       = durationEnv("PROXY_TIMEOUT_SECS", 15*time.Second)
	browserlessTimeout = durationEnv("BROWSERLESS_TIMEOUT_SECS", 30*time.Second)
)

func durationEnv(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return fallback
}

var chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// rateBucket tracks per-user request timestamps for rate limiting.
type rateBucket struct {
	mu    sync.Mutex
	times []time.Time
}

func (b *rateBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-proxyRateWindow)
	// Remove expired entries
	valid := b.times[:0]
	for _, t := range b.times {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	b.times = valid
	if len(b.times) >= proxyRateLimit {
		return false
	}
	b.times = append(b.times, now)
	return true
}

var (
	rateBuckets sync.Map // userID -> *rateBucket
)

func getUserBucket(userID string) *rateBucket {
	val, _ := rateBuckets.LoadOrStore(userID, &rateBucket{})
	return val.(*rateBucket)
}

// validateProxyURL checks the URL is safe to fetch (HTTPS, no private IPs).
func validateProxyURL(rawURL string) (*url.URL, error) {
	if len(rawURL) > proxyMaxURL {
		return nil, fmt.Errorf("URL too long (max %d characters)", proxyMaxURL)
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return nil, fmt.Errorf("only HTTPS URLs are allowed")
	}
	hostname := parsed.Hostname()
	if hostname == "" {
		return nil, fmt.Errorf("missing hostname")
	}

	// Resolve DNS and check for private IPs (SSRF prevention)
	ips, err := net.LookupHost(hostname)
	if err != nil {
		return nil, fmt.Errorf("cannot resolve hostname: %w", err)
	}
	for _, ipStr := range ips {
		ip := net.ParseIP(ipStr)
		if ip == nil {
			continue
		}
		if isPrivateIP(ip) {
			return nil, fmt.Errorf("URL resolves to a private/reserved IP address")
		}
	}
	return parsed, nil
}

// isPrivateIP checks if an IP is in a private/reserved range.
func isPrivateIP(ip net.IP) bool {
	privateRanges := []struct {
		network *net.IPNet
	}{
		{parseCIDR("10.0.0.0/8")},
		{parseCIDR("172.16.0.0/12")},
		{parseCIDR("192.168.0.0/16")},
		{parseCIDR("127.0.0.0/8")},
		{parseCIDR("169.254.0.0/16")},
		{parseCIDR("::1/128")},
		{parseCIDR("fc00::/7")},
		{parseCIDR("fe80::/10")},
	}
	for _, r := range privateRanges {
		if r.network.Contains(ip) {
			return true
		}
	}
	return false
}

func parseCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic("bad CIDR: " + s)
	}
	return n
}

// proxyFetchHandler handles POST /api/proxy/fetch.
// Fetches an external URL and returns the response body.
// If render=true is requested and Browserless is configured, uses headless Chrome
// to get JS-rendered HTML.
func proxyFetchHandler(queries *db.Queries, corsOrigin, browserlessEndpoint, browserlessToken string) http.HandlerFunc {
	client := &http.Client{
		Timeout: proxyTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}

	browserlessClient := &http.Client{Timeout: browserlessTimeout}

	return func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w, corsOrigin)

		userID, ok := authenticateHTTP(r, queries, w)
		if !ok {
			return
		}

		// Rate limit
		if !getUserBucket(userID).allow() {
			http.Error(w, "rate limit exceeded, try again later", http.StatusTooManyRequests)
			return
		}

		// Parse request body
		var req struct {
			URL    string `json:"url"`
			Render bool   `json:"render"`
		}
		body := http.MaxBytesReader(w, r.Body, 4096)
		if err := json.NewDecoder(body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		// Validate URL
		targetURL, err := validateProxyURL(req.URL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// If render requested and Browserless is configured, use it
		if req.Render && browserlessEndpoint != "" {
			data, ct, err := fetchViaBrowserless(r.Context(), browserlessClient, browserlessEndpoint, browserlessToken, targetURL.String())
			if err != nil {
				slog.Debug("proxy: browserless fetch error", "url", targetURL.String(), "error", err)
				http.Error(w, "could not render the page", http.StatusBadGateway)
				return
			}
			if ct != "" {
				w.Header().Set("Content-Type", ct)
			}
			w.Write(data)
			return
		}

		// Standard fetch
		fetchReq, err := http.NewRequestWithContext(r.Context(), "GET", targetURL.String(), nil)
		if err != nil {
			http.Error(w, "failed to create request", http.StatusInternalServerError)
			return
		}
		fetchReq.Header.Set("User-Agent", chromeUA)
		fetchReq.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/avif,*/*;q=0.8")
		fetchReq.Header.Set("Accept-Language", "en-US,en;q=0.9")

		resp, err := client.Do(fetchReq)
		if err != nil {
			slog.Debug("proxy: fetch error", "url", targetURL.String(), "error", err)
			http.Error(w, "could not reach the URL", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
			http.Error(w, "this site blocked the request", resp.StatusCode)
			return
		}
		if resp.StatusCode >= 400 {
			http.Error(w, fmt.Sprintf("upstream returned %d", resp.StatusCode), http.StatusBadGateway)
			return
		}

		// Read response body with size limit
		limited := io.LimitReader(resp.Body, proxyMaxBody)
		data, err := io.ReadAll(limited)
		if err != nil {
			http.Error(w, "error reading response", http.StatusBadGateway)
			return
		}

		// Forward content type
		ct := resp.Header.Get("Content-Type")
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.Write(data)
	}
}

// fetchViaBrowserless uses Browserless /content endpoint to get JS-rendered HTML.
func fetchViaBrowserless(ctx context.Context, client *http.Client, endpoint, token, targetURL string) ([]byte, string, error) {
	contentURL := strings.TrimRight(endpoint, "/") + "/content"
	if token != "" {
		contentURL += "?token=" + url.QueryEscape(token)
	}

	reqBody, _ := json.Marshal(map[string]any{
		"url":         targetURL,
		"gotoOptions": map[string]string{"waitUntil": "networkidle2"},
	})
	req, err := http.NewRequestWithContext(ctx, "POST", contentURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("browserless request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("browserless returned %d", resp.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, proxyMaxBody))
	if err != nil {
		return nil, "", err
	}

	return data, resp.Header.Get("Content-Type"), nil
}

// stripReasoningSpillover removes LLM reasoning that leaked into the content
// after the recipe output. Scans backwards for the last recipe-like line.
func stripReasoningSpillover(content string) string {
	lines := strings.Split(content, "\n")
	last := len(lines) - 1
	for i := last; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if l == "" {
			continue
		}
		// Recipe content patterns
		isRecipe := false
		if len(l) > 0 && l[0] >= '0' && l[0] <= '9' && strings.Contains(l, ".") {
			isRecipe = true // numbered step
		}
		if strings.HasPrefix(l, "![") {
			isRecipe = true // image
		}
		if strings.Contains(l, "|") {
			isRecipe = true // pipe-delimited ingredient
		}
		if strings.HasPrefix(l, "TITLE:") || strings.HasPrefix(l, "DESC:") ||
			strings.HasPrefix(l, "SERVINGS:") || strings.HasPrefix(l, "PREP:") ||
			strings.HasPrefix(l, "COOK:") || strings.HasPrefix(l, "TAGS:") ||
			strings.HasPrefix(l, "INGREDIENTS:") || strings.HasPrefix(l, "INSTRUCTIONS:") ||
			strings.HasPrefix(l, "ADDITIONAL IMAGES:") {
			isRecipe = true
		}
		if strings.HasPrefix(l, "@[") {
			isRecipe = true
		}
		if isRecipe {
			if i < last {
				return strings.Join(lines[:i+1], "\n")
			}
			return content
		}
		// Known reasoning prefixes — keep scanning backwards
		if strings.HasPrefix(l, "Wait") || strings.HasPrefix(l, "Actually") ||
			strings.HasPrefix(l, "Let me") || strings.HasPrefix(l, "I ") ||
			strings.HasPrefix(l, "Refining") || strings.HasPrefix(l, "Final") ||
			strings.HasPrefix(l, "Re-read") || strings.HasPrefix(l, "Hmm") ||
			strings.HasPrefix(l, "Notice") || strings.HasPrefix(l, "However") ||
			strings.HasPrefix(l, "One ") || strings.HasPrefix(l, "So ") {
			continue
		}
		// Unknown line — assume it's still recipe content
		if i < last {
			return strings.Join(lines[:i+1], "\n")
		}
		return content
	}
	return content
}

// proxyExtractHandler handles POST /api/proxy/extract.
// Accepts {url, mode} — fetches the page, extracts recipe data, optionally runs LLM pipeline.
// mode "ai": full LLM pipeline (returns simple text format with @[] tags)
// mode "basic": JSON-LD/microdata extraction only (returns simple text format, no LLM)
// Returns 501 if AI mode requested but no LLM endpoint is configured.
func proxyExtractHandler(queries *db.Queries, corsOrigin, llmEndpoint, browserlessEndpoint, browserlessToken string) http.HandlerFunc {
	fetchClient := &http.Client{
		Timeout: proxyTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}
	browserlessClient := &http.Client{Timeout: browserlessTimeout}
	llmCfg := loadLLMConfigFromEnv()
	if llmEndpoint != "" {
		llmCfg.CompletionsURL = normalizeChatCompletionsURL(llmEndpoint)
	}
	llm, err := newLLMClient(llmCfg)
	if err != nil {
		slog.Error("extract: failed to initialize LLM client", "error", err)
	}

	// ── Fetch HTML (static, then Browserless fallback) ───────────────────

	fetchHTML := func(ctx context.Context, targetURL string) (string, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", targetURL, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("User-Agent", chromeUA)
		req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

		resp, err := fetchClient.Do(req)
		if err != nil {
			return "", fmt.Errorf("fetch failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 400 {
			return "", fmt.Errorf("upstream returned %d", resp.StatusCode)
		}

		data, err := io.ReadAll(io.LimitReader(resp.Body, proxyMaxBody))
		if err != nil {
			return "", err
		}
		return string(data), nil
	}

	fetchViaBrowserlessStr := func(ctx context.Context, targetURL string) (string, error) {
		if browserlessEndpoint == "" {
			return "", fmt.Errorf("browserless not configured")
		}
		data, _, err := fetchViaBrowserless(ctx, browserlessClient, browserlessEndpoint, browserlessToken, targetURL)
		if err != nil {
			return "", err
		}
		return string(data), nil
	}

	// ── SSE helpers ─────────────────────────────────────────────────────

	sendSSE := func(w http.ResponseWriter, event string, data any) {
		jsonData, _ := json.Marshal(data)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, jsonData)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}

	type sseStatus struct {
		Step    string `json:"step"`
		Message string `json:"message"`
	}

	type sseError struct {
		Message string `json:"message"`
	}

	type sseWarning struct {
		Step    string `json:"step"`
		Message string `json:"message"`
	}

	// ── Handler ──────────────────────────────────────────────────────────

	return func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w, corsOrigin)

		userID, ok := authenticateHTTP(r, queries, w)
		if !ok {
			return
		}

		if !getUserBucket(userID).allow() {
			http.Error(w, "rate limit exceeded, try again later", http.StatusTooManyRequests)
			return
		}

		var req struct {
			URL  string `json:"url"`
			Mode string `json:"mode"` // "ai", "basic", or "probe"
		}
		body := http.MaxBytesReader(w, r.Body, 4096)
		if err := json.NewDecoder(body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		// Probe: frontend checks if LLM is available
		if req.Mode == "probe" {
			if llm == nil {
				http.Error(w, "LLM extraction not configured", http.StatusNotImplemented)
			} else {
				w.WriteHeader(http.StatusNoContent)
			}
			return
		}

		// Validate mode
		if req.Mode != "ai" && req.Mode != "basic" {
			http.Error(w, "mode must be 'ai' or 'basic'", http.StatusBadRequest)
			return
		}
		if req.Mode == "ai" && llm == nil {
			http.Error(w, "LLM extraction not configured", http.StatusNotImplemented)
			return
		}

		// Validate URL
		targetURL, err := validateProxyURL(req.URL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// ── Basic mode: fetch HTML and return for frontend-side extraction ──
		if req.Mode == "basic" {
			ctx, cancel := context.WithTimeout(r.Context(), proxyTimeout+35*time.Second)
			defer cancel()

			htmlContent, err := fetchHTML(ctx, targetURL.String())
			if err != nil {
				htmlContent, err = fetchViaBrowserlessStr(ctx, targetURL.String())
				if err != nil {
					http.Error(w, "could not fetch the URL", http.StatusBadGateway)
					return
				}
			}
			// Try Browserless if no JSON-LD found
			if !hasJsonLdRecipe(htmlContent) {
				if rendered, renderErr := fetchViaBrowserlessStr(ctx, targetURL.String()); renderErr == nil {
					htmlContent = rendered
				}
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(htmlContent))
			return
		}

		// ── AI mode: full server-side pipeline with SSE status updates ───

		ctx, cancel := context.WithTimeout(r.Context(), llmCfg.Timeout)
		defer cancel()

		// Set SSE headers — must be set before first write
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		// Ensure any panic sends an error event instead of dropping the connection
		defer func() {
			if r := recover(); r != nil {
				slog.Error("extract: panic", "error", r)
				sendSSE(w, "error", sseError{Message: "Internal server error."})
			}
		}()

		// Step 1: Fetch HTML
		sendSSE(w, "status", sseStatus{Step: "fetch", Message: "Fetching page..."})
		slog.Debug("extract: fetching", "url", targetURL.String())

		usedBrowserless := false
		htmlContent, err := fetchHTML(ctx, targetURL.String())
		if err != nil {
			slog.Debug("extract: static fetch failed", "error", err)
			htmlContent, err = fetchViaBrowserlessStr(ctx, targetURL.String())
			if err != nil {
				sendSSE(w, "error", sseError{Message: "Could not fetch the URL."})
				return
			}
			usedBrowserless = true
		}

		// Step 2: Check for JSON-LD, try Browserless if needed
		recipe, hasJsonLd := extractJsonLdRecipeData(htmlContent)

		if !hasJsonLd && !usedBrowserless {
			sendSSE(w, "status", sseStatus{Step: "render", Message: "Rendering page..."})
			slog.Debug("extract: no JSON-LD, trying browserless")
			if rendered, renderErr := fetchViaBrowserlessStr(ctx, targetURL.String()); renderErr == nil {
				htmlContent = rendered
				recipe, hasJsonLd = extractJsonLdRecipeData(htmlContent)
			}
		}

		// Step 3: Build simple format input
		// Check JSON-LD quality — must have both ingredients and instructions
		useJsonLd := hasJsonLd
		if useJsonLd {
			ings, _ := recipe["recipeIngredient"].([]any)
			instrs, _ := recipe["recipeInstructions"].([]any)
			instrStr, _ := recipe["recipeInstructions"].(string)
			if len(ings) == 0 || (len(instrs) == 0 && instrStr == "") {
				slog.Debug("extract: JSON-LD incomplete (missing ingredients or instructions), falling back to HTML")
				useJsonLd = false
			}
		}

		var simpleFormat string
		if useJsonLd {
			sendSSE(w, "status", sseStatus{Step: "build", Message: "Building recipe data..."})
			slog.Debug("extract: building simple format from JSON-LD")
			pageImages := extractPageImages(htmlContent)
			simpleFormat = buildSimpleFormatFromJsonLd(recipe, pageImages)
			slog.Debug("extract: simple format built", "length", len(simpleFormat), "content", simpleFormat[:min(len(simpleFormat), 500)])
		} else {
			sendSSE(w, "status", sseStatus{Step: "clean", Message: "Extracting recipe from page..."})
			slog.Debug("extract: no JSON-LD, cleaning HTML for LLM")
			llmInput := cleanHtmlForLlm(htmlContent)

			if len(llmInput) < 50 {
				sendSSE(w, "error", sseError{Message: "Could not extract content from this page."})
				return
			}

			// Pass 0: Raw extraction (thinking enabled)
			sendSSE(w, "status", sseStatus{Step: "pass0", Message: "Extracting recipe data..."})
			slog.Debug("extract: LLM pass 0 (raw extract)")
			pass0, err := llm.call(ctx, llmPassRawExtract, llm.prompts.RawExtract, llmInput)
			if err != nil {
				slog.Error("extract: LLM raw extract failed", "error", err)
				sendSSE(w, "error", sseError{Message: "AI extraction failed."})
				return
			}
			simpleFormat = pass0
		}

		// Pass 1: Extract — fix quantities, translations
		sendSSE(w, "status", sseStatus{Step: "pass1", Message: "Fixing quantities and units..."})
		slog.Debug("extract: LLM pass 1 (extract)")
		pass1, err := llm.call(ctx, llmPassExtract, llm.prompts.Extract, simpleFormat)
		if err != nil {
			slog.Warn("extract: LLM extract failed, using raw input", "error", err)
			sendSSE(w, "warning", sseWarning{Step: "pass1", Message: "Quantity/unit fixing skipped (AI timed out)."})
			pass1 = simpleFormat // graceful degradation
		}

		// Pass 2: Process — clean names, place images
		sendSSE(w, "status", sseStatus{Step: "pass2", Message: "Processing ingredients and images..."})
		slog.Debug("extract: LLM pass 2 (process)")
		pass2, err := llm.call(ctx, llmPassProcess, llm.prompts.Process, pass1)
		if err != nil {
			slog.Error("extract: LLM process failed", "error", err)
			sendSSE(w, "warning", sseWarning{Step: "pass2", Message: "Ingredient cleanup skipped (AI timed out)."})
			pass2 = pass1 // graceful degradation
		}

		// Pass 3: Tag — add @[] ingredient references
		sendSSE(w, "status", sseStatus{Step: "pass3", Message: "Tagging ingredients..."})
		slog.Debug("extract: LLM pass 3 (tag)")
		pass3, err := llm.call(ctx, llmPassTag, llm.prompts.Tag, pass2)
		if err != nil {
			slog.Error("extract: LLM tag failed", "error", err)
			sendSSE(w, "warning", sseWarning{Step: "pass3", Message: "Ingredient tagging skipped (AI timed out)."})
			pass3 = pass2 // graceful degradation
		}

		// Parse simple format → JSON
		sendSSE(w, "status", sseStatus{Step: "parse", Message: "Finalizing recipe..."})
		parsed, err := parseSimpleFormatToRecipe(pass3)
		if err != nil {
			slog.Error("extract: failed to parse LLM output", "error", err)
			sendSSE(w, "error", sseError{Message: "Could not parse recipe from AI output."})
			return
		}

		// Send result
		sendSSE(w, "result", parsed)
	}
}
