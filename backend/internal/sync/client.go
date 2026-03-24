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
	Type        string          `json:"type"`
	UserID      string          `json:"user_id,omitempty"`
	DeviceID    string          `json:"device_id,omitempty"`
	AuthHash    string          `json:"auth_hash,omitempty"`
	NewAuthHash string          `json:"new_auth_hash,omitempty"`
	WrappedKey  string          `json:"wrapped_key,omitempty"`
	DocID       string          `json:"doc_id,omitempty"`
	LastSeq     int64           `json:"last_seq,omitempty"`
	Payload     string          `json:"payload,omitempty"`
	Presence    json.RawMessage `json:"presence,omitempty"`
}

type ServerMessage struct {
	Type       string          `json:"type"`
	DocID      string          `json:"doc_id,omitempty"`
	Seq        int64           `json:"seq,omitempty"`
	Payload    string          `json:"payload,omitempty"`
	FromDevice string          `json:"from_device,omitempty"`
	LatestSeq  int64           `json:"latest_seq,omitempty"`
	Message    string          `json:"message,omitempty"`
	Presence   json.RawMessage `json:"presence,omitempty"`
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
		case "subscribe":
			c.handleSubscribe(ctx, msg)
		case "unsubscribe":
			c.handleUnsubscribe(msg)
		case "push":
			c.handlePush(ctx, msg)
		case "set_key":
			c.handleSetKey(ctx, msg)
		case "change_password":
			c.handleChangePassword(ctx, msg)
		case "purge":
			c.handlePurge(ctx)
		case "presence":
			c.handlePresence(msg)
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

	authResult, err := c.Queries.UpsertUser(ctx, msg.UserID, msg.AuthHash)
	if err != nil {
		c.sendError("auth error")
		log.Printf("client: auth error for user %s: %v", msg.UserID, err)
		return
	}
	if !authResult.OK {
		c.sendError("auth_failed")
		return
	}

	// Store wrapped master key if provided (first device)
	if msg.WrappedKey != "" && (authResult.IsNew || authResult.WrappedMasterKey == nil) {
		if err := c.Queries.SetWrappedMasterKey(ctx, msg.UserID, []byte(msg.WrappedKey)); err != nil {
			log.Printf("client: failed to store wrapped key: %v", err)
		}
	}

	if err := c.Queries.UpsertDevice(ctx, msg.DeviceID, msg.UserID); err != nil {
		c.sendError("device registration failed")
		log.Printf("client: device register error: %v", err)
		return
	}

	c.UserID = msg.UserID
	c.DeviceID = msg.DeviceID
	c.Hub.Register(c)

	// Send confirmation with wrapped key (so new devices can get the master key)
	connMsg := ServerMessage{Type: "connected", FromDevice: c.DeviceID}
	if authResult.WrappedMasterKey != nil {
		connMsg.Payload = string(authResult.WrappedMasterKey)
	}
	c.sendJSON(connMsg)
}

func (c *Client) handleSubscribe(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect before subscribing")
		return
	}
	if msg.DocID == "" {
		c.sendError("doc_id required for subscribe")
		return
	}

	c.Hub.Subscribe(c, msg.DocID)

	// Replay missed messages for this document
	messages, err := c.Queries.GetMessagesSince(ctx, c.UserID, msg.DocID, msg.LastSeq)
	if err != nil {
		c.sendError("failed to fetch history")
		log.Printf("client %s: subscribe history error for doc %s: %v", c.DeviceID, msg.DocID, err)
		return
	}

	for _, m := range messages {
		c.sendJSON(ServerMessage{
			Type:       "sync",
			DocID:      m.DocID,
			Seq:        m.Seq,
			Payload:    string(m.Payload),
			FromDevice: m.DeviceID,
		})
	}

	var latestSeq int64
	if len(messages) > 0 {
		latestSeq = messages[len(messages)-1].Seq
	} else {
		latestSeq = msg.LastSeq
	}
	c.sendJSON(ServerMessage{Type: "caught_up", DocID: msg.DocID, LatestSeq: latestSeq})
}

func (c *Client) handleUnsubscribe(msg ClientMessage) {
	if c.UserID == "" || msg.DocID == "" {
		return
	}
	c.Hub.Unsubscribe(c, msg.DocID)
}

func (c *Client) handlePush(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect before pushing")
		return
	}
	docID := msg.DocID
	if docID == "" {
		docID = "catalog" // backward compat
	}

	seq, err := c.Queries.StoreMessage(ctx, c.UserID, docID, c.DeviceID, []byte(msg.Payload))
	if err != nil {
		c.sendError("failed to store message")
		log.Printf("client %s: store error for doc %s: %v", c.DeviceID, docID, err)
		return
	}

	// Compact: keep only the latest snapshot for this document
	if err := c.Queries.CompactDocument(ctx, c.UserID, docID); err != nil {
		log.Printf("client %s: compact error for doc %s: %v", c.DeviceID, docID, err)
	}

	// Acknowledge to sender
	c.sendJSON(ServerMessage{Type: "ack", DocID: docID, Seq: seq})

	// Relay to other devices subscribed to this document
	relay, _ := json.Marshal(ServerMessage{
		Type:       "sync",
		DocID:      docID,
		Seq:        seq,
		Payload:    msg.Payload,
		FromDevice: c.DeviceID,
	})
	c.Hub.BroadcastDoc(c.UserID, docID, c.DeviceID, relay)
}

func (c *Client) handleSetKey(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect before setting key")
		return
	}
	if msg.WrappedKey == "" {
		c.sendError("wrapped_key required")
		return
	}
	if err := c.Queries.SetWrappedMasterKey(ctx, c.UserID, []byte(msg.WrappedKey)); err != nil {
		c.sendError("failed to store key")
		log.Printf("client %s: set key error: %v", c.DeviceID, err)
		return
	}
	c.sendJSON(ServerMessage{Type: "key_stored"})
}

func (c *Client) handlePurge(ctx context.Context) {
	if c.UserID == "" {
		c.sendError("must connect before purging")
		return
	}

	if err := c.Queries.PurgeUser(ctx, c.UserID); err != nil {
		c.sendError("purge failed")
		log.Printf("client %s: purge error: %v", c.DeviceID, err)
		return
	}

	log.Printf("hub: purged all data for user %s", c.UserID)
	msg, _ := json.Marshal(ServerMessage{Type: "purged"})
	c.Hub.Broadcast(c.UserID, "", msg)
	c.sendJSON(ServerMessage{Type: "purged"})
}

func (c *Client) handleChangePassword(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect before changing password")
		return
	}
	if msg.NewAuthHash == "" {
		c.sendError("new_auth_hash required")
		return
	}

	if err := c.Queries.UpdateAuthHash(ctx, c.UserID, msg.NewAuthHash); err != nil {
		c.sendError("password change failed")
		log.Printf("client %s: change password error: %v", c.DeviceID, err)
		return
	}

	if msg.WrappedKey != "" {
		if err := c.Queries.SetWrappedMasterKey(ctx, c.UserID, []byte(msg.WrappedKey)); err != nil {
			log.Printf("client %s: failed to update wrapped key: %v", c.DeviceID, err)
		}
	}

	log.Printf("hub: password changed for user %s", c.UserID)
	c.sendJSON(ServerMessage{Type: "password_change_ok"})

	relay, _ := json.Marshal(ServerMessage{Type: "password_changed"})
	c.Hub.Broadcast(c.UserID, c.DeviceID, relay)
}

func (c *Client) handlePresence(msg ClientMessage) {
	if c.UserID == "" {
		return
	}
	docID := msg.DocID
	if docID == "" {
		// Broadcast to all user devices (legacy)
		relay, _ := json.Marshal(ServerMessage{
			Type:       "presence",
			FromDevice: c.DeviceID,
			Presence:   msg.Presence,
		})
		c.Hub.Broadcast(c.UserID, c.DeviceID, relay)
		return
	}
	// Scope presence to document subscribers
	relay, _ := json.Marshal(ServerMessage{
		Type:       "presence",
		DocID:      docID,
		FromDevice: c.DeviceID,
		Presence:   msg.Presence,
	})
	c.Hub.BroadcastDoc(c.UserID, docID, c.DeviceID, relay)
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
