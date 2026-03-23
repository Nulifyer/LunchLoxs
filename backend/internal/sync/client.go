package sync

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"nhooyr.io/websocket"

	"github.com/kyle/recipepwa/backend/internal/db"
)

const (
	sendBufSize = 256
	writeWait   = 10 * time.Second
	pongWait    = 60 * time.Second
	pingPeriod  = 30 * time.Second
)

// Client represents a single WebSocket connection.
type Client struct {
	UserID   string
	DeviceID string
	Conn     *websocket.Conn
	Send     chan []byte
	Hub      *Hub
	Queries  *db.Queries
}

// --- Wire protocol (JSON) ---

type ClientMessage struct {
	Type     string `json:"type"`
	UserID   string `json:"user_id,omitempty"`
	DeviceID string `json:"device_id,omitempty"`
	AuthHash string `json:"auth_hash,omitempty"`
	LastSeq  int64  `json:"last_seq,omitempty"`
	Payload  string `json:"payload,omitempty"` // base64-encoded encrypted blob
}

type ServerMessage struct {
	Type       string `json:"type"`
	Seq        int64  `json:"seq,omitempty"`
	Payload    string `json:"payload,omitempty"` // base64-encoded encrypted blob
	FromDevice string `json:"from_device,omitempty"`
	LatestSeq  int64  `json:"latest_seq,omitempty"`
	Message    string `json:"message,omitempty"`
}

// ReadPump reads messages from the WebSocket and processes them.
func (c *Client) ReadPump(ctx context.Context) {
	defer func() {
		c.Hub.Unregister(c)
		c.Conn.Close(websocket.StatusNormalClosure, "")
	}()

	for {
		_, data, err := c.Conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != -1 {
				log.Printf("client %s: websocket closed: %v", c.DeviceID, err)
			}
			return
		}

		var msg ClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			c.sendError("invalid message format")
			continue
		}

		switch msg.Type {
		case "connect":
			c.handleConnect(ctx, msg)
		case "push":
			c.handlePush(ctx, msg)
		default:
			c.sendError("unknown message type: " + msg.Type)
		}
	}
}

// WritePump sends messages from the Send channel to the WebSocket.
func (c *Client) WritePump(ctx context.Context) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-c.Send:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, writeWait)
			err := c.Conn.Write(writeCtx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, writeWait)
			err := c.Conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (c *Client) handleConnect(ctx context.Context, msg ClientMessage) {
	if msg.UserID == "" || msg.DeviceID == "" || msg.AuthHash == "" {
		c.sendError("connect requires user_id, device_id, and auth_hash")
		return
	}

	// Authenticate
	ok, err := c.Queries.UpsertUser(ctx, msg.UserID, msg.AuthHash)
	if err != nil {
		c.sendError("auth error")
		log.Printf("client: auth error for user %s: %v", msg.UserID, err)
		return
	}
	if !ok {
		c.sendError("auth_failed")
		return
	}

	// Register device
	if err := c.Queries.UpsertDevice(ctx, msg.DeviceID, msg.UserID); err != nil {
		c.sendError("device registration failed")
		log.Printf("client: device register error: %v", err)
		return
	}

	c.UserID = msg.UserID
	c.DeviceID = msg.DeviceID
	c.Hub.Register(c)

	// Send confirmation
	c.sendJSON(ServerMessage{Type: "connected", FromDevice: c.DeviceID})

	// Replay missed messages
	messages, err := c.Queries.GetMessagesSince(ctx, c.UserID, msg.LastSeq)
	if err != nil {
		c.sendError("failed to fetch history")
		log.Printf("client: history fetch error: %v", err)
		return
	}

	for _, m := range messages {
		c.sendJSON(ServerMessage{
			Type:       "sync",
			Seq:        m.Seq,
			Payload:    string(m.Payload),
			FromDevice: m.DeviceID,
		})
	}

	// Signal catchup complete
	var latestSeq int64
	if len(messages) > 0 {
		latestSeq = messages[len(messages)-1].Seq
	} else {
		latestSeq = msg.LastSeq
	}
	c.sendJSON(ServerMessage{Type: "caught_up", LatestSeq: latestSeq})
}

func (c *Client) handlePush(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect before pushing")
		return
	}

	seq, err := c.Queries.StoreMessage(ctx, c.UserID, c.DeviceID, []byte(msg.Payload))
	if err != nil {
		c.sendError("failed to store message")
		log.Printf("client %s: store error: %v", c.DeviceID, err)
		return
	}

	// Acknowledge to sender
	c.sendJSON(ServerMessage{
		Type: "ack",
		Seq:  seq,
	})

	// Relay to other devices
	relay, _ := json.Marshal(ServerMessage{
		Type:       "sync",
		Seq:        seq,
		Payload:    msg.Payload,
		FromDevice: c.DeviceID,
	})
	c.Hub.Broadcast(c.UserID, c.DeviceID, relay)
}

func (c *Client) sendJSON(msg ServerMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("client %s: marshal error: %v", c.DeviceID, err)
		return
	}
	select {
	case c.Send <- data:
	default:
		log.Printf("client %s: send buffer full, dropping message", c.DeviceID)
	}
}

func (c *Client) sendError(message string) {
	c.sendJSON(ServerMessage{Type: "error", Message: message})
}
