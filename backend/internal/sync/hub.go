package sync

import (
	"log"
	"sync"
)

// Hub manages WebSocket clients grouped by user_id.
type Hub struct {
	mu      sync.RWMutex
	users   map[string]map[*Client]struct{} // user_id -> set of clients
}

func NewHub() *Hub {
	return &Hub{
		users: make(map[string]map[*Client]struct{}),
	}
}

func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.users[c.UserID] == nil {
		h.users[c.UserID] = make(map[*Client]struct{})
	}
	h.users[c.UserID][c] = struct{}{}
	log.Printf("hub: registered device %s for user %s (%d devices)",
		c.DeviceID, c.UserID, len(h.users[c.UserID]))
}

func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if clients, ok := h.users[c.UserID]; ok {
		delete(clients, c)
		if len(clients) == 0 {
			delete(h.users, c.UserID)
		}
	}
	log.Printf("hub: unregistered device %s for user %s", c.DeviceID, c.UserID)
}

// Broadcast sends a message to all clients of a user except the sender.
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
		select {
		case c.Send <- msg:
		default:
			// Client send buffer full, skip (will catch up on reconnect)
			log.Printf("hub: dropping message for slow client %s", c.DeviceID)
		}
	}
}
