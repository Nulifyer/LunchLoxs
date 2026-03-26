package sync

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/kyle/recipepwa/backend/internal/db"
)

const (
	writeWait    = 10 * time.Second
	pingPeriod   = 30 * time.Second
	maxReadBytes = 10 * 1024 * 1024 // 10 MB max WebSocket message size
	maxQueueSize = 10000            // hard cap to prevent unbounded memory
)

// RateConfig holds configurable rate limiting parameters.
type RateConfig struct {
	PerSec int // max messages per second per client
	Burst  int // burst allowance
}

// DefaultRateConfig returns the default rate limit configuration.
// Burst=200 accommodates bulk import flows where many docs are pushed in quick succession.
func DefaultRateConfig() RateConfig {
	return RateConfig{PerSec: 30, Burst: 200}
}

// Client represents a single WebSocket connection.
type Client struct {
	UserID   string
	DeviceID string
	Conn     *websocket.Conn
	Send     chan []byte // fed by Enqueue, drained by WritePump
	Hub      *Hub
	Queries  *db.Queries
	Rate     RateConfig
	tokens   int
	lastTick time.Time

	enqueue chan []byte   // producers write here; queuePump moves to Send
	done    chan struct{} // closed when connection tears down
}

// NewClient creates a Client with initialized channels.
func NewClient(conn *websocket.Conn, hub *Hub, queries *db.Queries, rate RateConfig) *Client {
	return &Client{
		Conn:    conn,
		Send:    make(chan []byte, 64), // small buffer; QueuePump handles backpressure
		Hub:     hub,
		Queries: queries,
		Rate:    rate,
		enqueue: make(chan []byte, 256), // producers write here
		done:    make(chan struct{}),
	}
}

// rateAllow checks if the client is within rate limits. Simple token bucket.
func (c *Client) rateAllow() bool {
	now := time.Now()
	elapsed := now.Sub(c.lastTick)
	c.lastTick = now
	// Refill tokens based on elapsed time
	c.tokens += int(elapsed.Seconds() * float64(c.Rate.PerSec))
	if c.tokens > c.Rate.Burst {
		c.tokens = c.Rate.Burst
	}
	if c.tokens <= 0 {
		return false
	}
	c.tokens--
	return true
}

// --- Wire protocol (JSON) ---

type ClientMessage struct {
	Type        string          `json:"type"`
	UserID      string          `json:"user_id,omitempty"`
	DeviceID    string          `json:"device_id,omitempty"`
	AuthHash    string          `json:"auth_hash,omitempty"`
	NewAuthHash string          `json:"new_auth_hash,omitempty"`
	IsSignup    bool            `json:"is_signup,omitempty"`
	WrappedKey  string          `json:"wrapped_key,omitempty"`
	DocID       string          `json:"doc_id,omitempty"`
	LastSeq     int64           `json:"last_seq,omitempty"`
	Payload     string          `json:"payload,omitempty"`
	Presence    json.RawMessage `json:"presence,omitempty"`
	// Identity keys
	PublicKey         string `json:"public_key,omitempty"`
	WrappedPrivateKey string `json:"wrapped_private_key,omitempty"`
	// Signing identity keys
	SigningPublicKey          string `json:"signing_public_key,omitempty"`
	WrappedSigningPrivateKey  string `json:"wrapped_signing_private_key,omitempty"`
	// Vault fields
	VaultID           string `json:"vault_id,omitempty"`
	TargetUserID      string `json:"target_user_id,omitempty"`
	EncryptedVaultKey string `json:"encrypted_vault_key,omitempty"`
	SenderPublicKey   string `json:"sender_public_key,omitempty"`
	Role              string `json:"role,omitempty"`
	NewRole           string `json:"new_role,omitempty"`
	// Vault key rotation
	VaultKeyUpdates []VaultKeyUpdateMsg `json:"vault_key_updates,omitempty"`
}

// VaultKeyUpdateMsg is the wire format for a single member's re-encrypted vault key.
type VaultKeyUpdateMsg struct {
	UserID            string `json:"user_id"`
	EncryptedVaultKey string `json:"encrypted_vault_key"`
	SenderPublicKey   string `json:"sender_public_key"`
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
	// Identity
	PublicKey                string `json:"public_key,omitempty"`
	WrappedPrivateKey        string `json:"wrapped_private_key,omitempty"`
	SigningPublicKey          string `json:"signing_public_key,omitempty"`
	WrappedSigningPrivateKey string `json:"wrapped_signing_private_key,omitempty"`
	SenderUserID             string `json:"sender_user_id,omitempty"`
	// Vault fields
	VaultID           string           `json:"vault_id,omitempty"`
	Vaults            []VaultInfoMsg   `json:"vaults,omitempty"`
	Members           []VaultMemberMsg `json:"members,omitempty"`
	EncryptedVaultKey string           `json:"encrypted_vault_key,omitempty"`
	Role              string           `json:"role,omitempty"`
	TargetUserID      string           `json:"target_user_id,omitempty"`
	TargetPublicKey   string           `json:"target_public_key,omitempty"`
	NewRole           string           `json:"new_role,omitempty"`
	RetryAfterMs      int              `json:"retry_after_ms,omitempty"`
}

type VaultInfoMsg struct {
	VaultID           string `json:"vault_id"`
	EncryptedVaultKey string `json:"encrypted_vault_key"`
	SenderPublicKey   string `json:"sender_public_key"`
	Role              string `json:"role"`
}

type VaultMemberMsg struct {
	UserID           string `json:"user_id"`
	Role             string `json:"role"`
	PublicKey        string `json:"public_key,omitempty"`
	SigningPublicKey string `json:"signing_public_key,omitempty"`
}

// ReadPump reads messages from the WebSocket and processes them.
func (c *Client) ReadPump(ctx context.Context) {
	c.Conn.SetReadLimit(maxReadBytes)
	c.tokens = c.Rate.Burst
	c.lastTick = time.Now()

	defer func() {
		close(c.done)
		c.Hub.Unregister(c)
		c.Conn.Close(websocket.StatusNormalClosure, "")
	}()

	for {
		_, data, err := c.Conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != -1 {
				slog.Info("client websocket closed", "device", c.DeviceID, "error", err)
			}
			return
		}

		// Parse first so we can log message type even when rate-limited
		var msg ClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			c.sendError("invalid message format")
			continue
		}

		// Heartbeat pings bypass rate limiting
		if msg.Type == "ping" {
			c.sendJSON(ServerMessage{Type: "pong"})
			continue
		}

		if !c.rateAllow() {
			// Tell client how long to wait for 1 token to refill
			retryMs := 1000 / c.Rate.PerSec
			if retryMs < 100 {
				retryMs = 100
			}
			slog.Debug("rate limited", "device", c.DeviceID, "type", msg.Type, "doc", msg.DocID)
			c.sendJSON(ServerMessage{Type: "error", Message: "rate_limited", RetryAfterMs: retryMs})
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
		case "set_identity":
			c.handleSetIdentity(ctx, msg)
		case "set_signing_identity":
			c.handleSetSigningIdentity(ctx, msg)
		case "create_vault":
			c.handleCreateVault(ctx, msg)
		case "list_vaults":
			c.handleListVaults(ctx)
		case "invite_to_vault":
			c.handleInviteToVault(ctx, msg)
		case "remove_from_vault":
			c.handleRemoveFromVault(ctx, msg)
		case "list_vault_members":
			c.handleListVaultMembers(ctx, msg)
		case "delete_vault":
			c.handleDeleteVault(ctx, msg)
		case "lookup_user":
			c.handleLookupUser(ctx, msg)
		case "presence":
			c.handlePresence(msg)
		case "transfer_ownership":
			c.handleTransferOwnership(ctx, msg)
		case "change_role":
			c.handleChangeRole(ctx, msg)
		case "rotate_vault_key":
			c.handleRotateVaultKey(ctx, msg)
		default:
			c.sendError("unknown message type: " + msg.Type)
		}
	}
}

// QueuePump buffers messages from Enqueue() into an internal FIFO and feeds
// them to the Send channel for WritePump. This decouples producers from the
// WebSocket write speed and prevents dropped messages under load.
// Must be run as a goroutine. Exits when done is closed.
func (c *Client) QueuePump() {
	var queue [][]byte
	defer close(c.Send)

	for {
		// If queue has messages, try to drain to Send alongside reading new ones
		if len(queue) > 0 {
			select {
			case c.Send <- queue[0]:
				queue[0] = nil // allow GC
				queue = queue[1:]
			case msg, ok := <-c.enqueue:
				if !ok {
					// enqueue closed -- drain remaining queue
					for _, m := range queue {
						c.Send <- m
					}
					return
				}
				if len(queue) < maxQueueSize {
					queue = append(queue, msg)
				} else {
					slog.Warn("queue full, dropping message", "device", c.DeviceID, "queued", len(queue))
				}
			case <-c.done:
				return
			}
		} else {
			// Queue empty -- block on new messages
			select {
			case msg, ok := <-c.enqueue:
				if !ok {
					return
				}
				queue = append(queue, msg)
			case <-c.done:
				return
			}
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

// Enqueue adds a message to the outbound queue. Non-blocking.
// Used by Hub broadcasts. Prefer sendJSON for server-originated messages.
func (c *Client) Enqueue(msg []byte) {
	select {
	case c.enqueue <- msg:
	case <-c.done:
	}
}

func (c *Client) handleConnect(ctx context.Context, msg ClientMessage) {
	if msg.UserID == "" || msg.DeviceID == "" || msg.AuthHash == "" {
		c.sendError("connect requires user_id, device_id, and auth_hash")
		return
	}

	// Auth check with minimum 2s duration to prevent timing-based enumeration
	start := time.Now()
	authResult, err := c.Queries.UpsertUser(ctx, msg.UserID, msg.AuthHash, msg.IsSignup)
	if elapsed := time.Since(start); elapsed < 2*time.Second {
		time.Sleep(2*time.Second - elapsed)
	}

	if err != nil {
		if err.Error() == "user_not_found" {
			c.sendError("user_not_found")
			return
		}
		if err.Error() == "user_already_exists" {
			c.sendError("user_already_exists")
			return
		}
		c.sendError("auth error")
		slog.Error("auth error", "user", msg.UserID, "error", err)
		return
	}
	if !authResult.OK {
		c.sendError("auth_failed")
		return
	}

	// Store wrapped master key if provided (first device)
	if msg.WrappedKey != "" && (authResult.IsNew || authResult.WrappedMasterKey == nil) {
		if err := c.Queries.SetWrappedMasterKey(ctx, msg.UserID, []byte(msg.WrappedKey)); err != nil {
			slog.Error("failed to store wrapped key", "error", err)
		}
	}

	if err := c.Queries.UpsertDevice(ctx, msg.DeviceID, msg.UserID); err != nil {
		c.sendError("device registration failed")
		slog.Error("device register error", "error", err)
		return
	}

	c.UserID = msg.UserID
	c.DeviceID = msg.DeviceID
	c.Hub.Register(c)

	// Send confirmation with wrapped key and identity info
	connMsg := ServerMessage{Type: "connected", FromDevice: c.DeviceID}
	if authResult.WrappedMasterKey != nil {
		connMsg.Payload = string(authResult.WrappedMasterKey)
	}
	if authResult.PublicKey != nil {
		connMsg.PublicKey = string(authResult.PublicKey)
	}
	if authResult.SigningPublicKey != nil {
		connMsg.SigningPublicKey = string(authResult.SigningPublicKey)
	}
	// Include wrapped private key so other devices can get it
	wpk, _ := c.Queries.GetWrappedPrivateKey(ctx, msg.UserID)
	if wpk != nil {
		connMsg.WrappedPrivateKey = string(wpk)
	}
	// Include wrapped signing private key
	wsk, _ := c.Queries.GetWrappedSigningPrivateKey(ctx, msg.UserID)
	if wsk != nil {
		connMsg.WrappedSigningPrivateKey = string(wsk)
	}
	c.sendJSON(connMsg)
}

// extractVaultID returns the vault ID prefix from a doc ID like "vaultId/subDoc",
// or empty string if the doc is not vault-scoped.
func extractVaultID(docID string) string {
	if idx := strings.Index(docID, "/"); idx > 0 {
		return docID[:idx]
	}
	return ""
}

// checkVaultAccess extracts the vault ID from a docID (format "vaultId/subDoc")
// and verifies the client is a member of that vault. Returns true if access is allowed.
func (c *Client) checkVaultAccess(ctx context.Context, docID string) bool {
	vaultID := extractVaultID(docID)
	if vaultID == "" {
		return true
	}
	isMember, _, err := c.Queries.IsVaultMember(ctx, vaultID, c.UserID)
	if err != nil {
		slog.Error("vault access check failed", "vault", vaultID, "user", c.UserID, "error", err)
		return false
	}
	return isMember
}

// checkVaultWriteAccess verifies the client is an owner or editor of the vault.
// Viewers can read but not write.
func (c *Client) checkVaultWriteAccess(ctx context.Context, docID string) bool {
	vaultID := extractVaultID(docID)
	if vaultID == "" {
		return true
	}
	isMember, role, err := c.Queries.IsVaultMember(ctx, vaultID, c.UserID)
	if err != nil {
		slog.Warn("vault write check db error", "vault", vaultID, "user", c.UserID, "doc", docID, "error", err)
		return false
	}
	if !isMember {
		slog.Warn("vault write denied: not a member", "vault", vaultID, "user", c.UserID, "doc", docID)
		return false
	}
	if role != "owner" && role != "editor" {
		slog.Warn("vault write denied: insufficient role", "vault", vaultID, "user", c.UserID, "role", role, "doc", docID)
		return false
	}
	return true
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

	// Vault-scoped authorization
	if !c.checkVaultAccess(ctx, msg.DocID) {
		c.sendError("not a member of this vault")
		return
	}

	c.Hub.Subscribe(c, msg.DocID)

	// Replay missed messages: use vault-scoped query if doc is vault-scoped
	var messages []db.SyncMessage
	var err error
	if vaultID := extractVaultID(msg.DocID); vaultID != "" {
		messages, err = c.Queries.GetVaultMessagesSince(ctx, vaultID, msg.DocID, msg.LastSeq)
	} else {
		messages, err = c.Queries.GetMessagesSince(ctx, c.UserID, msg.DocID, msg.LastSeq)
	}
	if err != nil {
		c.sendError("failed to fetch history")
		slog.Error("subscribe history error", "device", c.DeviceID, "doc", msg.DocID, "error", err)
		return
	}

	for _, m := range messages {
		c.sendJSON(ServerMessage{
			Type:         "sync",
			DocID:        m.DocID,
			Seq:          m.Seq,
			Payload:      string(m.Payload),
			FromDevice:   m.DeviceID,
			SenderUserID: m.UserID,
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

	// Vault-scoped authorization: need write access (owner or editor) to push
	if !c.checkVaultWriteAccess(ctx, docID) {
		c.sendJSON(ServerMessage{Type: "push_error", DocID: docID, Message: "insufficient permissions to write"})
		return
	}

	vaultID := extractVaultID(docID)

	var seq int64
	var err error
	if vaultID != "" {
		seq, err = c.Queries.StoreVaultMessage(ctx, vaultID, docID, c.UserID, c.DeviceID, []byte(msg.Payload))
	} else {
		seq, err = c.Queries.StoreMessage(ctx, c.UserID, docID, c.DeviceID, []byte(msg.Payload))
	}
	if err != nil {
		c.sendJSON(ServerMessage{Type: "push_error", DocID: docID, Message: "failed to store message"})
		slog.Error("store error", "device", c.DeviceID, "doc", docID, "error", err)
		return
	}

	// Compact: keep only the latest snapshot
	if vaultID != "" {
		if err := c.Queries.CompactVaultDocument(ctx, vaultID, docID); err != nil {
			slog.Error("compact error", "device", c.DeviceID, "doc", docID, "error", err)
		}
	} else {
		if err := c.Queries.CompactDocument(ctx, c.UserID, docID); err != nil {
			slog.Error("compact error", "device", c.DeviceID, "doc", docID, "error", err)
		}
	}

	// Acknowledge to sender
	c.sendJSON(ServerMessage{Type: "ack", DocID: docID, Seq: seq})

	// Relay to subscribers
	relay, _ := json.Marshal(ServerMessage{
		Type:         "sync",
		DocID:        docID,
		Seq:          seq,
		Payload:      msg.Payload,
		FromDevice:   c.DeviceID,
		SenderUserID: c.UserID,
	})
	if vaultID != "" {
		// Broadcast to all vault members subscribed to this doc
		memberIDs, _ := c.Queries.GetVaultMemberIDs(ctx, vaultID)
		c.Hub.BroadcastVaultDoc(memberIDs, docID, c.DeviceID, relay)
	} else {
		c.Hub.BroadcastDoc(c.UserID, docID, c.DeviceID, relay)
	}
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
		slog.Error("set key error", "device", c.DeviceID, "error", err)
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
		slog.Error("purge error", "device", c.DeviceID, "error", err)
		return
	}

	slog.Info("purged all data for user", "user", c.UserID)
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
		slog.Error("change password error", "device", c.DeviceID, "error", err)
		return
	}

	if msg.WrappedKey != "" {
		if err := c.Queries.SetWrappedMasterKey(ctx, c.UserID, []byte(msg.WrappedKey)); err != nil {
			slog.Error("failed to update wrapped key", "device", c.DeviceID, "error", err)
		}
	}

	slog.Info("password changed", "user", c.UserID)
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

// -- Identity key handlers --

func (c *Client) handleSetIdentity(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.PublicKey == "" || msg.WrappedPrivateKey == "" {
		c.sendError("public_key and wrapped_private_key required")
		return
	}
	if err := c.Queries.SetIdentityKeys(ctx, c.UserID, []byte(msg.PublicKey), []byte(msg.WrappedPrivateKey)); err != nil {
		c.sendError("failed to store identity keys")
		slog.Error("set identity error", "device", c.DeviceID, "error", err)
		return
	}
	c.sendJSON(ServerMessage{Type: "identity_stored"})
}

func (c *Client) handleSetSigningIdentity(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.SigningPublicKey == "" || msg.WrappedSigningPrivateKey == "" {
		c.sendError("signing_public_key and wrapped_signing_private_key required")
		return
	}
	if err := c.Queries.SetSigningKeys(ctx, c.UserID, []byte(msg.SigningPublicKey), []byte(msg.WrappedSigningPrivateKey)); err != nil {
		c.sendError("failed to store signing identity keys")
		slog.Error("set signing identity error", "device", c.DeviceID, "error", err)
		return
	}
	c.sendJSON(ServerMessage{Type: "signing_identity_stored"})
}

// -- Vault handlers --

func (c *Client) handleCreateVault(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.VaultID == "" || msg.EncryptedVaultKey == "" {
		c.sendError("vault_id and encrypted_vault_key required")
		return
	}
	if err := c.Queries.CreateVault(ctx, msg.VaultID, c.UserID, []byte(msg.EncryptedVaultKey), []byte(msg.SenderPublicKey)); err != nil {
		c.sendError("failed to create vault")
		slog.Error("create vault error", "device", c.DeviceID, "error", err)
		return
	}
	slog.Info("vault created", "vault", msg.VaultID, "user", c.UserID)
	c.sendJSON(ServerMessage{Type: "vault_created", VaultID: msg.VaultID})
	// Notify other devices of the same user
	broadcastMsg, _ := json.Marshal(ServerMessage{Type: "vault_created", VaultID: msg.VaultID})
	c.Hub.Broadcast(c.UserID, c.DeviceID, broadcastMsg)
}

func (c *Client) handleListVaults(ctx context.Context) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	vaults, err := c.Queries.ListVaults(ctx, c.UserID)
	if err != nil {
		c.sendError("failed to list vaults")
		slog.Error("list vaults error", "device", c.DeviceID, "error", err)
		return
	}
	var vaultMsgs []VaultInfoMsg
	for _, v := range vaults {
		vaultMsgs = append(vaultMsgs, VaultInfoMsg{
			VaultID:           v.VaultID,
			EncryptedVaultKey: string(v.EncryptedVaultKey),
			SenderPublicKey:   string(v.SenderPublicKey),
			Role:              v.Role,
		})
	}
	c.sendJSON(ServerMessage{Type: "vault_list", Vaults: vaultMsgs})
}

func (c *Client) handleInviteToVault(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.VaultID == "" || msg.TargetUserID == "" || msg.EncryptedVaultKey == "" {
		c.sendError("vault_id, target_user_id, and encrypted_vault_key required")
		return
	}

	// Check inviter is owner/editor of this vault
	isMember, role, err := c.Queries.IsVaultMember(ctx, msg.VaultID, c.UserID)
	if err != nil || !isMember {
		c.sendError("not a member of this vault")
		return
	}
	if role != "owner" && role != "editor" {
		c.sendError("insufficient permissions to invite")
		return
	}

	// Check target user exists (only need the first return value for existence check)
	pk, _, err := c.Queries.LookupUserByID(ctx, msg.TargetUserID)
	if err != nil || pk == nil {
		c.sendError("target user not found")
		return
	}

	inviteRole := msg.Role
	if inviteRole == "" {
		inviteRole = "viewer"
	}
	if inviteRole != "owner" && inviteRole != "editor" && inviteRole != "viewer" {
		c.sendError("invalid role: must be owner, editor, or viewer")
		return
	}

	if err := c.Queries.AddVaultMember(ctx, msg.VaultID, msg.TargetUserID, []byte(msg.EncryptedVaultKey), []byte(msg.SenderPublicKey), inviteRole, c.UserID); err != nil {
		c.sendError("failed to invite user")
		slog.Error("invite error", "device", c.DeviceID, "error", err)
		return
	}

	slog.Info("vault invite", "inviter", c.UserID, "target", msg.TargetUserID, "vault", msg.VaultID, "role", inviteRole)
	c.sendJSON(ServerMessage{Type: "vault_invite_ok", VaultID: msg.VaultID, TargetUserID: msg.TargetUserID})

	// Notify the invited user's connected devices
	relay, _ := json.Marshal(ServerMessage{
		Type:              "vault_invited",
		VaultID:           msg.VaultID,
		EncryptedVaultKey: msg.EncryptedVaultKey,
		Role:              inviteRole,
	})
	c.Hub.Broadcast(msg.TargetUserID, "", relay)
}

func (c *Client) handleRemoveFromVault(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.VaultID == "" || msg.TargetUserID == "" {
		c.sendError("vault_id and target_user_id required")
		return
	}

	isMember, role, err := c.Queries.IsVaultMember(ctx, msg.VaultID, c.UserID)
	if err != nil || !isMember || role != "owner" {
		c.sendError("only the owner can remove members")
		return
	}

	// Prevent owner from removing themselves
	if msg.TargetUserID == c.UserID {
		c.sendError("cannot remove yourself; transfer ownership first")
		return
	}

	// Prevent removing the last owner
	_, targetRole, err := c.Queries.IsVaultMember(ctx, msg.VaultID, msg.TargetUserID)
	if err != nil {
		c.sendError("failed to check target member")
		return
	}
	if targetRole == "owner" {
		ownerCount, err := c.Queries.CountVaultOwners(ctx, msg.VaultID)
		if err != nil {
			c.sendError("failed to count owners")
			return
		}
		if ownerCount <= 1 {
			c.sendError("cannot remove the last owner")
			return
		}
	}

	if err := c.Queries.RemoveVaultMember(ctx, msg.VaultID, msg.TargetUserID); err != nil {
		c.sendError("failed to remove member")
		slog.Error("remove member error", "device", c.DeviceID, "error", err)
		return
	}

	slog.Info("vault member removed", "remover", c.UserID, "target", msg.TargetUserID, "vault", msg.VaultID)
	c.sendJSON(ServerMessage{Type: "vault_member_removed", VaultID: msg.VaultID, TargetUserID: msg.TargetUserID})

	// Notify removed user
	relay, _ := json.Marshal(ServerMessage{Type: "vault_removed", VaultID: msg.VaultID})
	c.Hub.Broadcast(msg.TargetUserID, "", relay)
}

func (c *Client) handleListVaultMembers(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.VaultID == "" {
		c.sendError("vault_id required")
		return
	}

	isMember, _, err := c.Queries.IsVaultMember(ctx, msg.VaultID, c.UserID)
	if err != nil || !isMember {
		c.sendError("not a member of this vault")
		return
	}

	members, err := c.Queries.ListVaultMembers(ctx, msg.VaultID)
	if err != nil {
		c.sendError("failed to list members")
		slog.Error("list members error", "device", c.DeviceID, "error", err)
		return
	}

	var memberMsgs []VaultMemberMsg
	for _, m := range members {
		memberMsgs = append(memberMsgs, VaultMemberMsg{
			UserID:           m.UserID,
			Role:             m.Role,
			PublicKey:        string(m.PublicKey),
			SigningPublicKey: string(m.SigningPublicKey),
		})
	}
	c.sendJSON(ServerMessage{Type: "vault_members", VaultID: msg.VaultID, Members: memberMsgs})
}

func (c *Client) handleDeleteVault(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.VaultID == "" {
		c.sendError("vault_id required")
		return
	}

	isMember, role, err := c.Queries.IsVaultMember(ctx, msg.VaultID, c.UserID)
	if err != nil || !isMember || role != "owner" {
		c.sendError("only the owner can delete a vault")
		return
	}

	// Notify all members before deleting
	members, _ := c.Queries.ListVaultMembers(ctx, msg.VaultID)
	for _, m := range members {
		if m.UserID != c.UserID {
			relay, _ := json.Marshal(ServerMessage{Type: "vault_deleted", VaultID: msg.VaultID})
			c.Hub.Broadcast(m.UserID, "", relay)
		}
	}

	if err := c.Queries.DeleteVault(ctx, msg.VaultID); err != nil {
		c.sendError("failed to delete vault")
		slog.Error("delete vault error", "device", c.DeviceID, "error", err)
		return
	}

	slog.Info("vault deleted", "vault", msg.VaultID, "user", c.UserID)
	c.sendJSON(ServerMessage{Type: "vault_deleted", VaultID: msg.VaultID})
	// Notify other devices of the same user
	relay, _ := json.Marshal(ServerMessage{Type: "vault_deleted", VaultID: msg.VaultID})
	c.Hub.Broadcast(c.UserID, c.DeviceID, relay)
}

func (c *Client) handleLookupUser(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.TargetUserID == "" {
		c.sendError("target_user_id required")
		return
	}
	pk, signingPk, err := c.Queries.LookupUserByID(ctx, msg.TargetUserID)
	if err != nil || pk == nil {
		c.sendError("user not found or no public key")
		return
	}
	resp := ServerMessage{Type: "user_lookup", TargetUserID: msg.TargetUserID, TargetPublicKey: string(pk)}
	if signingPk != nil {
		resp.SigningPublicKey = string(signingPk)
	}
	c.sendJSON(resp)
}

func (c *Client) handleTransferOwnership(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.VaultID == "" || msg.TargetUserID == "" {
		c.sendError("vault_id and target_user_id required")
		return
	}

	// Verify requester is owner
	isMember, role, err := c.Queries.IsVaultMember(ctx, msg.VaultID, c.UserID)
	if err != nil || !isMember || role != "owner" {
		c.sendError("only the owner can transfer ownership")
		return
	}

	if err := c.Queries.TransferOwnership(ctx, msg.VaultID, c.UserID, msg.TargetUserID); err != nil {
		c.sendError("failed to transfer ownership")
		slog.Error("transfer ownership error", "device", c.DeviceID, "error", err)
		return
	}

	slog.Info("vault ownership transferred", "vault", msg.VaultID, "from", c.UserID, "to", msg.TargetUserID)
	c.sendJSON(ServerMessage{Type: "ownership_transferred", VaultID: msg.VaultID, TargetUserID: msg.TargetUserID})

	// Notify the new owner
	relay, _ := json.Marshal(ServerMessage{
		Type:         "ownership_received",
		VaultID:      msg.VaultID,
		TargetUserID: c.UserID,
	})
	c.Hub.Broadcast(msg.TargetUserID, "", relay)
}

func (c *Client) handleChangeRole(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.VaultID == "" || msg.TargetUserID == "" || msg.NewRole == "" {
		c.sendError("vault_id, target_user_id, and new_role required")
		return
	}

	// Validate role is one of the allowed values
	if msg.NewRole != "owner" && msg.NewRole != "editor" && msg.NewRole != "viewer" {
		c.sendError("invalid role: must be owner, editor, or viewer")
		return
	}

	// Verify requester is owner
	isMember, role, err := c.Queries.IsVaultMember(ctx, msg.VaultID, c.UserID)
	if err != nil || !isMember || role != "owner" {
		c.sendError("only the owner can change roles")
		return
	}

	// Prevent changing own role
	if msg.TargetUserID == c.UserID {
		c.sendError("cannot change your own role")
		return
	}

	// Prevent demoting the last owner
	_, targetRole, err := c.Queries.IsVaultMember(ctx, msg.VaultID, msg.TargetUserID)
	if err != nil {
		c.sendError("target user is not a member")
		return
	}
	if targetRole == "owner" && msg.NewRole != "owner" {
		ownerCount, err := c.Queries.CountVaultOwners(ctx, msg.VaultID)
		if err != nil {
			c.sendError("failed to count owners")
			return
		}
		if ownerCount <= 1 {
			c.sendError("cannot demote the last owner")
			return
		}
	}

	if err := c.Queries.ChangeRole(ctx, msg.VaultID, msg.TargetUserID, msg.NewRole); err != nil {
		c.sendError("failed to change role")
		slog.Error("change role error", "device", c.DeviceID, "error", err)
		return
	}

	slog.Info("vault role changed", "vault", msg.VaultID, "target", msg.TargetUserID, "newRole", msg.NewRole)
	c.sendJSON(ServerMessage{Type: "role_changed", VaultID: msg.VaultID, TargetUserID: msg.TargetUserID, NewRole: msg.NewRole})

	// Notify the target user
	relay, _ := json.Marshal(ServerMessage{
		Type:         "role_changed",
		VaultID:      msg.VaultID,
		TargetUserID: msg.TargetUserID,
		NewRole:      msg.NewRole,
	})
	c.Hub.Broadcast(msg.TargetUserID, "", relay)
}

func (c *Client) handleRotateVaultKey(ctx context.Context, msg ClientMessage) {
	if c.UserID == "" {
		c.sendError("must connect first")
		return
	}
	if msg.VaultID == "" || len(msg.VaultKeyUpdates) == 0 {
		c.sendError("vault_id and vault_key_updates required")
		return
	}

	// Verify sender is owner
	isMember, role, err := c.Queries.IsVaultMember(ctx, msg.VaultID, c.UserID)
	if err != nil || !isMember || role != "owner" {
		c.sendError("only the owner can rotate vault keys")
		return
	}

	// Convert wire format to DB format
	updates := make([]db.VaultKeyUpdate, len(msg.VaultKeyUpdates))
	for i, u := range msg.VaultKeyUpdates {
		updates[i] = db.VaultKeyUpdate{
			UserID:            u.UserID,
			EncryptedVaultKey: []byte(u.EncryptedVaultKey),
			SenderPublicKey:   []byte(u.SenderPublicKey),
		}
	}

	if err := c.Queries.RotateVaultKeys(ctx, msg.VaultID, updates); err != nil {
		c.sendError("failed to rotate vault keys")
		slog.Error("rotate vault key error", "device", c.DeviceID, "vault", msg.VaultID, "error", err)
		return
	}

	slog.Info("vault key rotated", "vault", msg.VaultID, "user", c.UserID)

	// Broadcast vault_key_rotated to all members
	memberIDs, _ := c.Queries.GetVaultMemberIDs(ctx, msg.VaultID)
	relay, _ := json.Marshal(ServerMessage{Type: "vault_key_rotated", VaultID: msg.VaultID})
	for _, uid := range memberIDs {
		c.Hub.Broadcast(uid, "", relay)
	}
}

func (c *Client) sendJSON(msg ServerMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("marshal error", "device", c.DeviceID, "error", err)
		return
	}
	c.Enqueue(data)
}

func (c *Client) sendError(message string) {
	c.sendJSON(ServerMessage{Type: "error", Message: message})
}
