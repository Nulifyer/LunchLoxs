package server

import (
	"log"
	"net/http"

	"nhooyr.io/websocket"

	"github.com/kyle/recipepwa/backend/internal/db"
	syncpkg "github.com/kyle/recipepwa/backend/internal/sync"
)

func NewMux(queries *db.Queries, frontendURL string) *http.ServeMux {
	hub := syncpkg.NewHub()
	mux := http.NewServeMux()

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: []string{"*"},
		})
		if err != nil {
			log.Printf("ws: accept error: %v", err)
			return
		}

		client := &syncpkg.Client{
			Conn:    conn,
			Send:    make(chan []byte, 256),
			Hub:     hub,
			Queries: queries,
		}

		ctx := r.Context()
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
