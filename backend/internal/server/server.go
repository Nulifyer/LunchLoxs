package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"

	"github.com/kyle/recipepwa/backend/internal/db"
	syncpkg "github.com/kyle/recipepwa/backend/internal/sync"
)

const maxBlobSize = 10 << 20 // 10 MB

func securityHeaders(next http.Handler, frontendURL string) http.Handler {
	isLocalhost := strings.Contains(frontendURL, "localhost") || strings.Contains(frontendURL, "127.0.0.1")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLocalhost {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"connect-src 'self' wss: ws:; img-src 'self' blob: data:; "+
				"object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

type muxConfig struct {
	browserlessEndpoint string
	browserlessToken    string
}

// MuxOption configures optional NewMux behaviour.
type MuxOption func(*muxConfig)

// WithBrowserless sets the Browserless endpoint for JS-rendered page fetching.
func WithBrowserless(endpoint, token string) MuxOption {
	return func(c *muxConfig) { c.browserlessEndpoint = endpoint; c.browserlessToken = token }
}

func NewMux(queries *db.Queries, frontendURL string, rateConfig syncpkg.RateConfig, opts ...MuxOption) http.Handler {
	cfg := muxConfig{}
	for _, o := range opts {
		o(&cfg)
	}

	hub := syncpkg.NewHub()
	mux := http.NewServeMux()

	originPatterns := buildOriginPatterns(frontendURL)

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: originPatterns,
		})
		if err != nil {
			slog.Error("ws: accept error", "error", err)
			return
		}

		client := syncpkg.NewClient(conn, hub, queries, rateConfig)

		ctx := r.Context()
		go client.QueuePump()
		go client.WritePump(ctx)
		client.ReadPump(ctx)
	})

	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// -- Blob endpoints --

	corsOrigin := buildCORSOrigin(frontendURL)

	mux.HandleFunc("PUT /api/vaults/{vaultId}/blobs/{checksum}", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w, corsOrigin)

		userID, ok := authenticateHTTP(r, queries, w)
		if !ok {
			return
		}

		vaultID := r.PathValue("vaultId")
		checksum := r.PathValue("checksum")

		isMember, role, err := queries.IsVaultMember(r.Context(), vaultID, userID)
		if err != nil || !isMember {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if role == "viewer" {
			http.Error(w, "viewers cannot upload", http.StatusForbidden)
			return
		}

		body := http.MaxBytesReader(w, r.Body, maxBlobSize)
		data, err := io.ReadAll(body)
		if err != nil {
			http.Error(w, "payload too large or read error", http.StatusRequestEntityTooLarge)
			return
		}

		mimeType := r.Header.Get("X-Blob-Mime-Type")
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		filename := r.Header.Get("X-Blob-Filename")

		if err := queries.PutBlob(r.Context(), vaultID, checksum, mimeType, filename, data, len(data)); err != nil {
			slog.Error("blob: put error", "error", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
	})

	mux.HandleFunc("GET /api/vaults/{vaultId}/blobs/{checksum}", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w, corsOrigin)

		userID, ok := authenticateHTTP(r, queries, w)
		if !ok {
			return
		}

		vaultID := r.PathValue("vaultId")
		checksum := r.PathValue("checksum")

		isMember, _, err := queries.IsVaultMember(r.Context(), vaultID, userID)
		if err != nil || !isMember {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		data, _, err := queries.GetBlob(r.Context(), vaultID, checksum)
		if err == pgx.ErrNoRows {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			slog.Error("blob: get error", "error", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		w.Write(data)
	})

	// -- Proxy endpoint (recipe URL import) --
	mux.HandleFunc("POST /api/proxy/fetch", proxyFetchHandler(queries, corsOrigin, cfg.browserlessEndpoint, cfg.browserlessToken))

	// CORS preflight for API endpoints
	mux.HandleFunc("OPTIONS /api/", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w, corsOrigin)
		w.WriteHeader(http.StatusNoContent)
	})

	return securityHeaders(mux, frontendURL)
}

// authenticateHTTP verifies X-User-ID + X-Auth-Hash headers.
func authenticateHTTP(r *http.Request, queries *db.Queries, w http.ResponseWriter) (string, bool) {
	userID := r.Header.Get("X-User-ID")
	authHash := r.Header.Get("X-Auth-Hash")
	if userID == "" || authHash == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", false
	}
	// Minimum delay to prevent timing attacks
	start := time.Now()
	ok, err := queries.AuthenticateUser(r.Context(), userID, authHash)
	elapsed := time.Since(start)
	if elapsed < 50*time.Millisecond {
		time.Sleep(50*time.Millisecond - elapsed)
	}
	if err != nil || !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return "", false
	}
	return userID, true
}

func setCORSHeaders(w http.ResponseWriter, origin string) {
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "X-User-ID, X-Auth-Hash, Content-Type")
}

func buildCORSOrigin(frontendURL string) string {
	parsed, err := url.Parse(frontendURL)
	if err != nil {
		return frontendURL
	}
	return parsed.Scheme + "://" + parsed.Host
}

// buildOriginPatterns extracts origin patterns from the frontend URL.
// If the URL contains "localhost", it also allows common localhost variants.
func buildOriginPatterns(frontendURL string) []string {
	if frontendURL == "*" {
		return []string{"*"}
	}
	parsed, err := url.Parse(frontendURL)
	if err != nil {
		slog.Warn("failed to parse frontend URL, falling back to exact match", "url", frontendURL, "error", err)
		return []string{frontendURL}
	}

	host := parsed.Hostname()
	port := parsed.Port()

	var patterns []string

	if port != "" {
		patterns = append(patterns, host+":"+port)
	} else {
		patterns = append(patterns, host)
	}

	if strings.Contains(host, "localhost") {
		// Also allow 127.0.0.1 with the same port
		if port != "" {
			patterns = append(patterns, "127.0.0.1:"+port)
			patterns = append(patterns, "localhost:"+port)
		} else {
			patterns = append(patterns, "127.0.0.1")
			patterns = append(patterns, "localhost")
		}
	}

	slog.Info("websocket origin patterns", "patterns", patterns)
	return patterns
}
