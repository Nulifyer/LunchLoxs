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
	"strings"
	"sync"
	"time"

	"github.com/kyle/recipepwa/backend/internal/db"
)

const (
	proxyTimeout      = 15 * time.Second
	proxyMaxBody      = 5 << 20  // 5 MB
	proxyMaxURL       = 2048
	proxyRateLimit    = 10 // requests per minute per user
	proxyRateWindow   = time.Minute
	llmTimeout        = 10 * time.Minute
	llmMaxRequestBody = 200 << 10 // 200 KB
)

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

	browserlessClient := &http.Client{Timeout: 30 * time.Second}

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

// proxyExtractHandler handles POST /api/proxy/extract.
// Forwards recipe data to an OpenAI-compatible LLM endpoint for enhanced extraction.
// Returns 501 if no LLM endpoint is configured.
func proxyExtractHandler(queries *db.Queries, corsOrigin string, llmEndpoint string) http.HandlerFunc {
	if llmEndpoint == "" {
		return func(w http.ResponseWriter, r *http.Request) {
			setCORSHeaders(w, corsOrigin)
			http.Error(w, "LLM extraction not configured", http.StatusNotImplemented)
		}
	}

	llmURL := strings.TrimRight(llmEndpoint, "/") + "/v1/chat/completions"
	client := &http.Client{Timeout: llmTimeout}

	extractPrompt := `You are a recipe data enhancer. You receive recipe data in a simple text format. Clean it up and output the SAME format back.

Example input/output format:
TITLE: Recipe Name
DESC: Brief description
SERVINGS: 4
PREP: 15
COOK: 30
TAGS: mexican, quick, easy

INGREDIENTS:
2 | cup | all-purpose flour
1 | tsp | salt
3 | | large eggs

INSTRUCTIONS:
1. Full step text here.
![Step 1 photo](https://example.com/step1.jpg)
2. Another full step here.

Your job:
- Fix any ingredients missing quantities by inferring reasonable defaults (e.g. "salt" → "1 | tsp | salt", "large flour tortillas" → "2 | | large flour tortillas").
- Keep units lowercase singular (cup, tsp, tbsp, oz, lb, g, ml).
- CRITICAL: Keep ALL instruction text EXACTLY as-is. Do NOT shorten, summarize, or paraphrase any step.
- Keep ALL images exactly where they are. Do NOT remove or move any ![alt](url) lines.
- If there is an ADDITIONAL IMAGES section, try to place relevant cooking/dish images into the instructions near the most relevant step. Remove the ADDITIONAL IMAGES section after placing them.
- Output ONLY the same plain text format. No JSON, no markdown fencing, no explanation.`

	enhancePrompt := `You are a recipe text enhancer. You receive a recipe in simple text format. Your ONLY job is to tag ingredient mentions in the INSTRUCTIONS section using the format @[item name] (at-sign, open square bracket, the exact item name from INGREDIENTS, close square bracket).

Example input:
INGREDIENTS:
1/2 | tsp | olive oil
2 | | flour tortillas
1 | cup | grated cheese
8 | oz | egg noodles

INSTRUCTIONS:
1. Heat oil in a pan. Place a tortilla in the pan.
2. Sprinkle cheese on top.
3. Cook the noodles separately.

Example output:
INGREDIENTS:
1/2 | tsp | olive oil
2 | | flour tortillas
1 | cup | grated cheese
8 | oz | egg noodles

INSTRUCTIONS:
1. Heat @[olive oil] in a pan. Place a @[flour tortillas] in the pan.
2. Sprinkle @[grated cheese] on top.
3. Cook the @[egg noodles] separately.

Notice how partial words are matched to the full ingredient name:
- "oil" -> @[olive oil]
- "tortilla" -> @[flour tortillas]
- "cheese" -> @[grated cheese]
- "noodles" -> @[egg noodles]
In a recipe, when the instructions mention a word like "noodles", "broth", "oil", etc., it refers to the ingredient in the INGREDIENTS list. Always tag it with the FULL ingredient item name.

Rules:
- The tag format is @[item name] — the @ sign, then [ then the ingredient item name, then ]. Example: @[bok choy]
- Match aggressively: any word in the instructions that refers to an ingredient should be tagged. "noodles" matches "wonton noodles", "broth" matches "chicken broth", "oil" matches "olive oil".
- Match to the MOST SPECIFIC ingredient. If the list has both "wontons" and "wonton noodles", then "wontons" in the text matches @[wontons], and "noodles" matches @[wonton noodles]. Do not confuse similar ingredients.
- ONLY add @[] tags. Do NOT change, shorten, or remove ANY other text, images, or step numbers.
- Output the COMPLETE recipe in the same format (all sections: TITLE, DESC, SERVINGS, PREP, COOK, TAGS, INGREDIENTS, INSTRUCTIONS).`

	// callLLM sends a system+user prompt and returns the raw content string.
	callLLM := func(ctx context.Context, system, user string) (string, error) {
		llmReq := map[string]any{
			"messages": []map[string]string{
				{"role": "system", "content": system},
				{"role": "user", "content": "/no_think\n" + user},
			},
			"temperature": 0,
			"max_tokens":  4096,
		}
		llmBody, err := json.Marshal(llmReq)
		if err != nil {
			return "", err
		}

		httpReq, err := http.NewRequestWithContext(ctx, "POST", llmURL, bytes.NewReader(llmBody))
		if err != nil {
			return "", err
		}
		httpReq.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(httpReq)
		if err != nil {
			return "", fmt.Errorf("LLM request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("LLM returned %d", resp.StatusCode)
		}

		var llmResp struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, proxyMaxBody)).Decode(&llmResp); err != nil {
			return "", fmt.Errorf("failed to parse LLM response: %w", err)
		}
		if len(llmResp.Choices) == 0 {
			return "", fmt.Errorf("LLM returned no choices")
		}

		content := strings.TrimSpace(llmResp.Choices[0].Message.Content)
		// Strip markdown fences
		if strings.HasPrefix(content, "```") {
			lines := strings.Split(content, "\n")
			if len(lines) >= 3 {
				content = strings.Join(lines[1:len(lines)-1], "\n")
			}
		}
		return content, nil
	}

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
			Text string `json:"text"`
			Pass string `json:"pass"` // "extract" or "enhance"
		}
		body := http.MaxBytesReader(w, r.Body, llmMaxRequestBody)
		if err := json.NewDecoder(body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if len(req.Text) < 20 {
			http.Error(w, "text too short", http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), llmTimeout)
		defer cancel()

		// Select prompt based on pass
		prompt := extractPrompt
		if req.Pass == "enhance" {
			prompt = enhancePrompt
		}

		result, err := callLLM(ctx, prompt, req.Text)
		if err != nil {
			slog.Error("proxy: LLM call failed", "pass", req.Pass, "error", err)
			http.Error(w, "LLM processing failed", http.StatusBadGateway)
			return
		}

		// Basic validation — check for TITLE: in the output
		if !strings.Contains(result, "TITLE:") && !strings.Contains(result, "INGREDIENTS:") {
			slog.Error("proxy: LLM returned unexpected format", "content", result[:min(len(result), 200)])
			http.Error(w, "LLM returned unexpected format", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(result))
	}
}
