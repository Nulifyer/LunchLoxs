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
	browserlessClient := &http.Client{Timeout: 30 * time.Second}
	llmClient := &http.Client{Timeout: llmTimeout}

	var llmURL string
	if llmEndpoint != "" {
		llmURL = strings.TrimRight(llmEndpoint, "/") + "/v1/chat/completions"
	}

	// ── Prompts (synced with test script) ────────────────────────────────

	rawExtractPrompt := `You are a recipe extractor. You receive the raw text content of a web page that contains a recipe but has NO structured data. The text may contain <img> HTML tags — these are images from the page in their original position.

Your job is to find the recipe and output it in a specific simple text format.

Extract the recipe and output it in EXACTLY this format:

TITLE: Recipe Name
DESC: A short description of the dish
SERVINGS: 4
PREP: 30
COOK: 45
TAGS: tag1, tag2, tag3

INGREDIENTS:
2 | cup | flour
1 | tsp | salt
3 | | eggs

INSTRUCTIONS:
1. First step text here.
![alt text](image-url)
2. Second step text here.
3. Third step text here.

Rules:
- Every ingredient line must be: quantity | unit | item name
- Units must be standard: cup, tsp, tbsp, oz, lb, g, ml, clove, can, bunch, piece. Keep units lowercase singular.
- If an ingredient has no unit (countable items like eggs), leave unit empty: "3 | | eggs"
- Infer reasonable quantities for ingredients that don't specify one (e.g. salt -> "1 | tsp | salt").
- PREP and COOK are in minutes. Set to 0 if not mentioned.
- SERVINGS defaults to 4 if not mentioned.
- Instructions must be numbered steps. Keep the FULL original text of each step — do NOT summarize or shorten.
- IMAGES: Convert any <img> tags to ![alt](src) format. Place each image on its own line after the instruction step it relates to. Use the alt attribute for the alt text, and the src attribute for the URL. Skip images that are clearly not recipe photos (logos, badges, avatars).
- TAGS: include cuisine type, dish type, dietary info, or other relevant tags from the page.
- NON-ENGLISH: If the recipe is not in English, keep the original text AND add English translations:
  - For TITLE: "Original Title (English Translation)"
  - For ingredient items: "original name (english name)" e.g. "鶏レバー (chicken liver)"
  - For each instruction step, add the English translation on the next line prefixed with "> " e.g.:
    1. レバーを一口大に切る。
    > Cut the liver into bite-sized pieces.
  - DESC and TAGS should be in English.
- IGNORE irrelevant or duplicate content: skip reviews, comments, related recipes, author bios, ads, navigation, repeated text, and other non-recipe content.
- Output ONLY the plain text format above. No JSON, no markdown fencing, no explanation.
- If the page contains multiple recipes, extract only the primary/main one.`

	extractPrompt := `You are a recipe data fixer. You receive recipe data in a simple text format. Fix any issues and output the SAME format back.

Your job:
- Every ingredient MUST have an accurate quantity and unit that makes sense. Parse the original text carefully to extract the measurement. Examples:
  "5 to 6 ounces baby spinach" -> "5 | oz | baby spinach"
  "1 large can (28 ounces) diced tomatoes" -> "28 | oz | diced tomatoes"
  "2 cups (16 ounces) cottage cheese" -> "2 | cup | cottage cheese"
  If the ingredient truly has no unit (countable items like eggs), leave unit empty: "3 | | eggs"
  Do NOT leave unit empty when the source text specifies a measurement.
- Fix any ingredients missing quantities by inferring reasonable defaults (e.g. " | | salt" -> "1 | tsp | salt").
- Units must be a standard measurement: cup, tsp, tbsp, oz, lb, g, ml, clove, can, bunch, piece. Do NOT use the ingredient name as the unit. Keep units lowercase singular.
- Merge duplicate ingredients ONLY if they are truly the same item used for the same purpose (combine quantities). Do NOT merge ingredients that share a name but are used in different parts of the recipe (e.g. "3/4 cup sugar" for a topping and "2 tbsp sugar" for a batter are separate ingredients — keep both).
- CRITICAL: Keep ALL instruction text EXACTLY as-is. Do NOT shorten, summarize, or paraphrase any step.
- Keep ALL images exactly where they are. Do NOT remove or move any ![alt](url) lines.
- Decode any HTML entities in the text (e.g. &#8217; -> ', &frac14; -> 1/4, &frac12; -> 1/2, &frac34; -> 3/4).
- Output ONLY the same plain text format. No JSON, no markdown fencing, no explanation.`

	processPrompt := `You are a recipe data processor. You receive recipe data in a simple text format. You have TWO jobs:

JOB 1 — Clean up ingredient names:
Strip parenthetical sizes, verbose qualifiers, and prep notes from ingredient item names. Keep the name short and recognizable.

Examples:
- "large can (28 ounces) diced tomatoes" -> "diced tomatoes"
- "(2 cups) freshly grated low-moisture, part-skim mozzarella cheese" -> "mozzarella cheese"
- "large carrots, chopped (about 1 cup)" -> "carrots, chopped"
- "roughly chopped fresh basil + additional for garnish" -> "fresh basil"
- "cloves garlic, pressed or minced" -> "garlic, minced"
- "medium zucchini, chopped" -> "zucchini, chopped"
- "to 6 ounces baby spinach" -> "baby spinach"
- "no-boil lasagna noodles*" -> "lasagna noodles"
Move stripped size info (like "28 ounces", "2 cups") into the quantity/unit fields if not already there.

JOB 2 — Place images into instructions:
If there is an ADDITIONAL IMAGES section at the bottom, move EACH image to INSIDE the instructions. Place each image on its own line directly AFTER the step it relates to. Match the image alt text to the step content. Remove images that are clearly unrelated (logos, author photos, other recipe thumbnails, banners). Delete the ADDITIONAL IMAGES section completely when done.

For EVERY image in the ADDITIONAL IMAGES section, ask: "which step does this image show?" and place it after that step.

Example input:
INSTRUCTIONS:
1. Sauté the vegetables until golden.
2. Mix the cottage cheese filling.
3. Layer the noodles and sauce.

ADDITIONAL IMAGES:
![sautéed vegetables](https://example.com/sauteed.jpg)
![cottage cheese filling mixture](https://example.com/filling.jpg)
![layering the lasagna](https://example.com/layers.jpg)
![Author Kate](https://example.com/kate.jpg)

Example output:
INSTRUCTIONS:
1. Sauté the vegetables until golden.
![sautéed vegetables](https://example.com/sauteed.jpg)
2. Mix the cottage cheese filling.
![cottage cheese filling mixture](https://example.com/filling.jpg)
3. Layer the noodles and sauce.
![layering the lasagna](https://example.com/layers.jpg)

Notice: "Author Kate" was removed (unrelated). Each cooking image was placed after its matching step.

Rules:
- CRITICAL: Keep ALL instruction text EXACTLY as-is. Do NOT shorten or paraphrase.
- CRITICAL: Ingredients MUST stay in pipe-delimited format: quantity | unit | item. Do NOT drop the pipes.
- Output the COMPLETE recipe in the same format (TITLE, DESC, SERVINGS, PREP, COOK, TAGS, INGREDIENTS, INSTRUCTIONS).
- No JSON, no markdown fencing, no explanation.`

	tagPrompt := `You are a recipe text tagger. You receive a recipe in simple text format. Your ONLY job is to tag ingredient mentions in the INSTRUCTIONS section using the format @[item name] (at-sign, open square bracket, the exact item name from INGREDIENTS, close square bracket).

Example input:
TITLE: Simple Pasta
DESC: A quick pasta dish.
SERVINGS: 2
PREP: 5
COOK: 10
TAGS: italian, quick

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
TITLE: Simple Pasta
DESC: A quick pasta dish.
SERVINGS: 2
PREP: 5
COOK: 10
TAGS: italian, quick

INGREDIENTS:
1/2 | tsp | olive oil
2 | | flour tortillas
1 | cup | grated cheese
8 | oz | egg noodles

INSTRUCTIONS:
1. Heat @[olive oil] in a pan. Place a @[flour tortillas] in the pan.
2. Sprinkle @[grated cheese] on top.
3. Cook the @[egg noodles] separately.

Notice: "oil" -> @[olive oil], "tortilla" -> @[flour tortillas], "cheese" -> @[grated cheese], "noodles" -> @[egg noodles].

Rules:
- The tag format is @[item name] — @ then [ then ingredient item name then ]. Example: @[bok choy]
- Match aggressively: any word that refers to an ingredient should be tagged. Examples:
  "noodles" -> @[wonton noodles], "broth" -> @[chicken broth], "oil" -> @[olive oil],
  "spinach" -> @[baby spinach], "cheese" -> @[mozzarella cheese] or @[cottage cheese] depending on context,
  "pepper" -> @[black pepper] or @[red pepper flakes] or @[bell pepper] depending on context.
- Match to the MOST SPECIFIC ingredient. If the list has both "wontons" and "wonton noodles", then "wontons" matches @[wontons] and "noodles" matches @[wonton noodles].
- Tag EVERY mention of an ingredient throughout the instructions, not just the first occurrence.
- Do NOT tag inside image alt text (inside ![...] brackets). Only tag in instruction step text.
- ONLY add @[] tags. Do NOT change, shorten, or remove ANY other text, images, or step numbers.
- IMPORTANT: Output the COMPLETE recipe starting from TITLE through the end. Include ALL sections: TITLE, DESC, SERVINGS, PREP, COOK, TAGS, INGREDIENTS, INSTRUCTIONS. Do not skip the header.`

	// ── LLM caller ───────────────────────────────────────────────────────

	callLLM := func(ctx context.Context, system, user string, enableThinking bool) (string, error) {
		temp := 0.7
		topP := 0.8
		maxTokens := 8192
		if enableThinking {
			temp = 0.6
			topP = 0.95
			maxTokens = 16384
		}
		llmReq := map[string]any{
			"messages": []map[string]string{
				{"role": "system", "content": system},
				{"role": "user", "content": user},
			},
			"temperature":          temp,
			"top_p":                topP,
			"top_k":                20,
			"min_p":                0.05,
			"repetition_penalty":   1.05,
			"max_tokens":           maxTokens,
			"chat_template_kwargs": map[string]any{"enable_thinking": enableThinking},
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

		resp, err := llmClient.Do(httpReq)
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
		if idx := strings.Index(content, "<think>"); idx == 0 {
			if end := strings.Index(content, "</think>"); end > 0 {
				content = strings.TrimSpace(content[end+len("</think>"):])
			}
		}
		if strings.HasPrefix(content, "```") {
			lines := strings.Split(content, "\n")
			if len(lines) >= 3 {
				content = strings.Join(lines[1:len(lines)-1], "\n")
			}
		}
		content = stripReasoningSpillover(content)
		return content, nil
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
			Text string `json:"text"` // pre-built simple format (JSON-LD path)
			Mode string `json:"mode"` // "ai" or "basic"
		}
		body := http.MaxBytesReader(w, r.Body, llmMaxRequestBody)
		if err := json.NewDecoder(body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		if req.Mode == "ai" && llmURL == "" {
			http.Error(w, "LLM extraction not configured", http.StatusNotImplemented)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), llmTimeout)
		defer cancel()

		// ── Text-only path: frontend already built simple format from JSON-LD ──
		if req.Text != "" {
			if llmURL == "" {
				http.Error(w, "LLM extraction not configured", http.StatusNotImplemented)
				return
			}
			// Run LLM passes 1-3 on pre-built simple format (skip pass 0)
			slog.Debug("extract: LLM pass 1 (extract) on pre-built input")
			pass1, err := callLLM(ctx, extractPrompt, req.Text, false)
			if err != nil {
				slog.Error("extract: LLM extract failed", "error", err)
				http.Error(w, "LLM extraction failed", http.StatusBadGateway)
				return
			}
			slog.Debug("extract: LLM pass 2 (process)")
			pass2, err := callLLM(ctx, processPrompt, pass1, false)
			if err != nil {
				pass2 = pass1
			}
			slog.Debug("extract: LLM pass 3 (tag)")
			pass3, err := callLLM(ctx, tagPrompt, pass2, true)
			if err != nil {
				pass3 = pass2
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Write([]byte(pass3))
			return
		}

		// ── URL path: full fetch + extract pipeline ──────────────────────

		// Validate URL
		targetURL, err := validateProxyURL(req.URL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// ── Step 1: Fetch HTML ───────────────────────────────────────────
		slog.Debug("extract: fetching", "url", targetURL.String())
		htmlContent, err := fetchHTML(ctx, targetURL.String())
		if err != nil {
			slog.Debug("extract: static fetch failed", "error", err)
			// Try Browserless as fallback for 403s etc.
			htmlContent, err = fetchViaBrowserlessStr(ctx, targetURL.String())
			if err != nil {
				http.Error(w, "could not fetch the URL", http.StatusBadGateway)
				return
			}
		}

		// ── Step 2: Check for JSON-LD ────────────────────────────────────
		hasJsonLd := strings.Contains(htmlContent, `"@type"`) && strings.Contains(htmlContent, `"Recipe"`)

		// If no JSON-LD on static HTML, try Browserless (JS rendering may produce it)
		if !hasJsonLd {
			slog.Debug("extract: no JSON-LD, trying browserless")
			rendered, renderErr := fetchViaBrowserlessStr(ctx, targetURL.String())
			if renderErr == nil {
				htmlContent = rendered
				hasJsonLd = strings.Contains(htmlContent, `"@type"`) && strings.Contains(htmlContent, `"Recipe"`)
			}
		}

		// ── Step 3: Build LLM input or return basic extraction ───────────
		if req.Mode == "basic" || (req.Mode == "ai" && llmURL == "") {
			// Basic mode — just return whatever we have. Frontend parses JSON-LD.
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(htmlContent))
			return
		}

		// AI mode — build input and run LLM pipeline
		var llmInput string
		if hasJsonLd {
			// Frontend will have built simple format from JSON-LD — but now we do it server-side.
			// For now, send the HTML back and let frontend build simple format, then call us again.
			// TODO: move buildSimpleFormat to Go for full server-side pipeline.
			//
			// Actually — keep it simple. Send the HTML with JSON-LD back to the frontend.
			// The frontend already knows how to buildSimpleFormat from JSON-LD.
			// Only use the LLM pipeline for the no-JSON-LD case where we need cleanHtmlForLlm.
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(htmlContent))
			return
		}

		// No JSON-LD — clean HTML and run full LLM pipeline server-side
		slog.Debug("extract: no JSON-LD, cleaning HTML for LLM")
		llmInput = cleanHtmlForLlm(htmlContent)

		if len(llmInput) < 50 {
			http.Error(w, "could not extract content from page", http.StatusBadGateway)
			return
		}

		// Pass 0: Raw extraction (thinking enabled)
		slog.Debug("extract: LLM pass 0 (raw extract)")
		pass0, err := callLLM(ctx, rawExtractPrompt, llmInput, true)
		if err != nil {
			slog.Error("extract: LLM raw extract failed", "error", err)
			http.Error(w, "LLM extraction failed", http.StatusBadGateway)
			return
		}

		// Pass 1: Extract (no thinking)
		slog.Debug("extract: LLM pass 1 (extract)")
		pass1, err := callLLM(ctx, extractPrompt, pass0, false)
		if err != nil {
			slog.Error("extract: LLM extract failed", "error", err)
			http.Error(w, "LLM extraction failed", http.StatusBadGateway)
			return
		}

		// Pass 2: Process (no thinking)
		slog.Debug("extract: LLM pass 2 (process)")
		pass2, err := callLLM(ctx, processPrompt, pass1, false)
		if err != nil {
			slog.Error("extract: LLM process failed", "error", err)
			pass2 = pass1
		}

		// Pass 3: Tag (thinking enabled)
		slog.Debug("extract: LLM pass 3 (tag)")
		pass3, err := callLLM(ctx, tagPrompt, pass2, true)
		if err != nil {
			slog.Error("extract: LLM tag failed", "error", err)
			pass3 = pass2
		}

		if !strings.Contains(pass3, "TITLE:") && !strings.Contains(pass3, "INGREDIENTS:") {
			slog.Error("extract: LLM returned unexpected format", "content", pass3[:min(len(pass3), 200)])
			http.Error(w, "LLM returned unexpected format", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(pass3))
	}
}
