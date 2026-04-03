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

	extractPrompt := `You are a recipe data processor. You receive either raw JSON-LD recipe data or cleaned HTML text from a recipe page. Produce clean structured JSON.

Return ONLY valid JSON with this exact structure:
{
  "title": "Recipe Name",
  "description": "Brief description",
  "servings": 4,
  "prepMinutes": 15,
  "cookMinutes": 30,
  "ingredients": [
    {"quantity": "2", "unit": "cup", "item": "all-purpose flour"},
    {"quantity": "1", "unit": "tsp", "item": "salt"},
    {"quantity": "3", "unit": "", "item": "large eggs"}
  ],
  "instructions": "1. First step\n[IMAGE: https://example.com/step1.jpg]\n2. Second step",
  "tags": ["mexican", "quick"]
}

Rules:
- ingredients: Parse each ingredient string into separate quantity, unit, and item fields. quantity is just the number as a string (e.g. "2", "1/2", "1 1/2"). unit is the measurement word, lowercase singular (e.g. "cup", "tbsp", "tsp", "oz", "lb", "g", "ml"). item is the ingredient name with any prep notes (e.g. "onion, diced"). If the source text does not specify a quantity, try to infer a reasonable default from context or common cooking knowledge (e.g. "salt" -> "1", "tsp"; "large flour tortillas" -> "2", ""). Use empty string only if truly unknown.
- instructions: Numbered steps as a single string. After each step that has an associated image, add the image URL on its own line as [IMAGE: url]. Use the first image URL from each step if multiple are provided.
- tags: Combine recipeCategory, recipeCuisine, and keywords into a flat lowercase list. Remove duplicates.
- Do NOT invent instructions or ingredients not present in the source. You MAY infer reasonable quantities for ingredients that lack them.
- Return ONLY the JSON object. No markdown fencing, no explanation.`

	enhancePrompt := `You are a recipe text enhancer. You receive a JSON recipe with an ingredients array and an instructions string. Your job is to tag ingredient references in the instructions.

For every mention of an ingredient in the instructions text, wrap it with @[item name] where "item name" matches the ingredient's "item" field exactly (case-insensitive match, use the exact item field value).

Example input ingredients: [{"item": "olive oil"}, {"item": "flour tortillas"}, {"item": "grated cheese"}]
Example input instructions: "1. Heat oil in a pan. Place a tortilla in the pan.\n2. Sprinkle cheese on top."
Example output instructions: "1. Heat @[olive oil] in a pan. Place a @[flour tortillas] in the pan.\n2. Sprinkle @[grated cheese] on top."

Rules:
- Only tag ingredients that appear in the ingredients list. Do not invent tags.
- Match ingredient names flexibly (e.g. "cheese" matches item "grated cheese", "tortilla" matches "flour tortillas").
- Do NOT modify anything else — keep all step numbers, [IMAGE: url] markers, and text exactly as-is.
- Return ONLY the modified instructions string. No JSON wrapping, no explanation, no markdown.`

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

		// Pass 1: Extract structured recipe data
		extracted, err := callLLM(ctx, extractPrompt, "Process this recipe data:\n\n"+req.Text)
		if err != nil {
			slog.Error("proxy: LLM extract failed", "error", err)
			http.Error(w, "LLM extraction failed", http.StatusBadGateway)
			return
		}

		// Validate extracted JSON
		var recipe map[string]any
		if err := json.Unmarshal([]byte(extracted), &recipe); err != nil {
			slog.Error("proxy: LLM returned invalid JSON", "error", err, "content", extracted[:min(len(extracted), 200)])
			http.Error(w, "LLM returned invalid data", http.StatusBadGateway)
			return
		}
		title, _ := recipe["title"].(string)
		if title == "" {
			http.Error(w, "LLM could not extract a recipe", http.StatusUnprocessableEntity)
			return
		}

		// Pass 2: Enhance instructions with ingredient tagging
		instructions, _ := recipe["instructions"].(string)
		ingredients, _ := recipe["ingredients"].([]any)
		if instructions != "" && len(ingredients) > 0 {
			ingredientJSON, _ := json.Marshal(ingredients)
			enhanceInput := "Ingredients:\n" + string(ingredientJSON) + "\n\nInstructions:\n" + instructions
			enhanced, err := callLLM(ctx, enhancePrompt, enhanceInput)
			if err == nil && len(enhanced) > 20 {
				recipe["instructions"] = enhanced
				// Re-serialize
				extracted, _ = func() (string, error) {
					b, e := json.Marshal(recipe)
					return string(b), e
				}()
			} else {
				slog.Debug("proxy: LLM enhance skipped", "error", err)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(extracted))
	}
}
