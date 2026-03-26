package server

import (
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"

	"github.com/kyle/recipepwa/backend/internal/db"
	syncpkg "github.com/kyle/recipepwa/backend/internal/sync"
)

func NewMux(queries *db.Queries, frontendURL string, rateConfig syncpkg.RateConfig) *http.ServeMux {
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

	return mux
}

// buildOriginPatterns extracts origin patterns from the frontend URL.
// If the URL contains "localhost", it also allows common localhost variants.
func buildOriginPatterns(frontendURL string) []string {
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
