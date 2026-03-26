package sync

import (
	"log/slog"
	"sync"
)

// Hub manages WebSocket clients grouped by user_id with per-document subscriptions.
type Hub struct {
	mu    sync.RWMutex
	// user_id -> set of clients (for user-level broadcasts: purge, password change)
	users map[string]map[*Client]struct{}
	// user_id -> doc_id -> set of clients (for document-scoped sync)
	docs map[string]map[string]map[*Client]struct{}
}

func NewHub() *Hub {
	return &Hub{
		users: make(map[string]map[*Client]struct{}),
		docs:  make(map[string]map[string]map[*Client]struct{}),
	}
}

func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.users[c.UserID] == nil {
		h.users[c.UserID] = make(map[*Client]struct{})
	}
	h.users[c.UserID][c] = struct{}{}
	slog.Info("hub: registered device", "device", c.DeviceID, "user", c.UserID, "devices", len(h.users[c.UserID]))
}

func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// Remove from user set
	if clients, ok := h.users[c.UserID]; ok {
		delete(clients, c)
		if len(clients) == 0 {
			delete(h.users, c.UserID)
		}
	}
	// Remove from all document subscriptions
	if userDocs, ok := h.docs[c.UserID]; ok {
		for docID, clients := range userDocs {
			delete(clients, c)
			if len(clients) == 0 {
				delete(userDocs, docID)
			}
		}
		if len(userDocs) == 0 {
			delete(h.docs, c.UserID)
		}
	}
	slog.Info("hub: unregistered device", "device", c.DeviceID, "user", c.UserID)
}

// Subscribe a client to a specific document.
func (h *Hub) Subscribe(c *Client, docID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.docs[c.UserID] == nil {
		h.docs[c.UserID] = make(map[string]map[*Client]struct{})
	}
	if h.docs[c.UserID][docID] == nil {
		h.docs[c.UserID][docID] = make(map[*Client]struct{})
	}
	h.docs[c.UserID][docID][c] = struct{}{}
}

// Unsubscribe a client from a specific document.
func (h *Hub) Unsubscribe(c *Client, docID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if userDocs, ok := h.docs[c.UserID]; ok {
		if clients, ok := userDocs[docID]; ok {
			delete(clients, c)
			if len(clients) == 0 {
				delete(userDocs, docID)
			}
		}
	}
}

// BroadcastDoc sends a message to all clients of a user subscribed to a document,
// except the sender.
func (h *Hub) BroadcastDoc(userID, docID, senderDeviceID string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clients, ok := h.docs[userID][docID]
	if !ok {
		return
	}
	for c := range clients {
		if c.DeviceID == senderDeviceID {
			continue
		}
		c.Enqueue(msg)
	}
}

// BroadcastVaultDoc sends a message to all clients of any vault member subscribed to a doc,
// except the sender. Used for vault-scoped sync messages.
func (h *Hub) BroadcastVaultDoc(memberUserIDs []string, docID, senderDeviceID string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, uid := range memberUserIDs {
		clients, ok := h.docs[uid][docID]
		if !ok {
			continue
		}
		for c := range clients {
			if c.DeviceID == senderDeviceID {
				continue
			}
			c.Enqueue(msg)
		}
	}
}

// Broadcast sends a message to all clients of a user except the sender.
// Used for user-level events (purge, password change).
func (h *Hub) Broadcast(userID string, senderDeviceID string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clients, ok := h.users[userID]
	if !ok {
		return
	}
	for c := range clients {
		if c.DeviceID == senderDeviceID {
			continue
		}
		c.Enqueue(msg)
	}
}
