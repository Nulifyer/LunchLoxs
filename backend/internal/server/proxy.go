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
	proxyTimeout    = 15 * time.Second
	proxyMaxBody    = 5 << 20 // 5 MB
	proxyMaxURL     = 2048
	proxyRateLimit  = 10 // requests per minute per user
	proxyRateWindow = time.Minute
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
