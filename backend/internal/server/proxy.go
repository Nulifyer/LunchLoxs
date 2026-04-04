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
- NON-ENGLISH: If the recipe text is not in English:
  - Keep ALL original non-English text in the original form. Do NOT replace it with English. Instead do the following:
  - For ingredient items: append "(english name)" e.g. "Arroz bomba" -> "Arroz bomba (bomba rice)"
  - For each instruction step, keep the original non-english text, then add an English translation on the NEXT line starting with "> ". Example:
    1. Freír el pollo en aceite.
    > Fry the chicken in oil.
    2. Añadir el agua.
    > Add the water.
  - DESC and TAGS should be in English.
  - If translations already exist, preserve them. Do NOT duplicate steps.
- Output ONLY the same plain text format. No JSON, no markdown fencing, no explanation.`

	processPrompt := `You are a recipe data processor. You receive recipe data in a simple text format. You have TWO jobs:

JOB 1 — Clean up ingredient names:
Strip parenthetical sizes, verbose qualifiers, and prep notes from ingredient item names. Keep the name short and recognizable. Do NOT strip English translation parentheses from non-English ingredients (e.g. keep "Arroz bomba (bomba rice)" as-is).

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
- NON-ENGLISH: Preserve any existing translations (parenthetical English names on ingredients, "> " translation lines after instructions). If translations are missing, add them.
- Output the COMPLETE recipe in the same format (TITLE, DESC, SERVINGS, PREP, COOK, TAGS, INGREDIENTS, INSTRUCTIONS).
- No JSON, no markdown fencing, no explanation.`

	tagPrompt := `You are a recipe text tagger. You receive a recipe in simple text format. Your ONLY job is to tag ingredient mentions in the INSTRUCTIONS section using the format @[item name] (at-sign, open square bracket, the EXACT and COMPLETE item name from the INGREDIENTS list including any parenthetical translations, close square bracket).

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
- ONLY add @[] tags. Do NOT wrap them in backticks or code formatting. Do NOT change, shorten, or remove ANY other text, images, or step numbers.
- NON-ENGLISH: Preserve any existing translations (parenthetical English names on ingredients, "> " translation lines after instructions). Tag ingredient mentions in BOTH the original language lines AND the "> " translation lines.
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
			if llmURL == "" {
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
		if req.Mode == "ai" && llmURL == "" {
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

		ctx, cancel := context.WithTimeout(r.Context(), llmTimeout)
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
			pass0, err := callLLM(ctx, rawExtractPrompt, llmInput, true)
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
		pass1, err := callLLM(ctx, extractPrompt, simpleFormat, true)
		if err != nil {
			slog.Error("extract: LLM extract failed", "error", err)
			sendSSE(w, "error", sseError{Message: "AI extraction failed."})
			return
		}

		// Pass 2: Process — clean names, place images
		sendSSE(w, "status", sseStatus{Step: "pass2", Message: "Processing ingredients and images..."})
		slog.Debug("extract: LLM pass 2 (process)")
		pass2, err := callLLM(ctx, processPrompt, pass1, false)
		if err != nil {
			slog.Error("extract: LLM process failed", "error", err)
			pass2 = pass1 // graceful degradation
		}

		// Pass 3: Tag — add @[] ingredient references
		sendSSE(w, "status", sseStatus{Step: "pass3", Message: "Tagging ingredients..."})
		slog.Debug("extract: LLM pass 3 (tag)")
		pass3, err := callLLM(ctx, tagPrompt, pass2, true)
		if err != nil {
			slog.Error("extract: LLM tag failed", "error", err)
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
