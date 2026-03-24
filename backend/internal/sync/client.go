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
	// Identity keys
	PublicKey         string `json:"public_key,omitempty"`
	WrappedPrivateKey string `json:"wrapped_private_key,omitempty"`
	// Vault fields
	VaultID           string `json:"vault_id,omitempty"`
	TargetUserID      string `json:"target_user_id,omitempty"`
	EncryptedVaultKey string `json:"encrypted_vault_key,omitempty"`
	SenderPublicKey   string `json:"sender_public_key,omitempty"`
	Role              string `json:"role,omitempty"`
	NewRole           string `json:"new_role,omitempty"`
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
	PublicKey         string `json:"public_key,omitempty"`
	WrappedPrivateKey string `json:"wrapped_private_key,omitempty"`
	// Vault fields
	VaultID           string           `json:"vault_id,omitempty"`
	Vaults            []VaultInfoMsg   `json:"vaults,omitempty"`
	Members           []VaultMemberMsg `json:"members,omitempty"`
	EncryptedVaultKey string           `json:"encrypted_vault_key,omitempty"`
	Role              string           `json:"role,omitempty"`
	TargetUserID      string           `json:"target_user_id,omitempty"`
	TargetPublicKey   string           `json:"target_public_key,omitempty"`
	NewRole           string           `json:"new_role,omitempty"`
}

type VaultInfoMsg struct {
	VaultID           string `json:"vault_id"`
	EncryptedVaultKey string `json:"encrypted_vault_key"`
	SenderPublicKey   string `json:"sender_public_key"`
	Role              string `json:"role"`
}

type VaultMemberMsg struct {
	UserID    string `json:"user_id"`
	Role      string `json:"role"`
	PublicKey string `json:"public_key,omitempty"`
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
				slog.Info("client websocket closed", "device", c.DeviceID, "error", err)
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
		case "set_identity":
			c.handleSetIdentity(ctx, msg)
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
	// Include wrapped private key so other devices can get it
	wpk, _ := c.Queries.GetWrappedPrivateKey(ctx, msg.UserID)
	if wpk != nil {
		connMsg.WrappedPrivateKey = string(wpk)
	}
	c.sendJSON(connMsg)
}

// checkVaultAccess extracts the vault ID from a docID (format "vaultId/subDoc")
// and verifies the client is a member of that vault. Returns true if access is allowed.
func (c *Client) checkVaultAccess(ctx context.Context, docID string) bool {
	idx := strings.Index(docID, "/")
	if idx < 0 {
		// No vault prefix -- personal doc, always allowed
		return true
	}
	vaultID := docID[:idx]
	isMember, _, err := c.Queries.IsVaultMember(ctx, vaultID, c.UserID)
	if err != nil {
		slog.Error("vault access check failed", "vault", vaultID, "user", c.UserID, "error", err)
		return false
	}
	return isMember
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

	// Replay missed messages for this document
	messages, err := c.Queries.GetMessagesSince(ctx, c.UserID, msg.DocID, msg.LastSeq)
	if err != nil {
		c.sendError("failed to fetch history")
		slog.Error("subscribe history error", "device", c.DeviceID, "doc", msg.DocID, "error", err)
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

	// Vault-scoped authorization
	if !c.checkVaultAccess(ctx, docID) {
		c.sendError("not a member of this vault")
		return
	}

	seq, err := c.Queries.StoreMessage(ctx, c.UserID, docID, c.DeviceID, []byte(msg.Payload))
	if err != nil {
		c.sendError("failed to store message")
		slog.Error("store error", "device", c.DeviceID, "doc", docID, "error", err)
		return
	}

	// Compact: keep only the latest snapshot for this document
	if err := c.Queries.CompactDocument(ctx, c.UserID, docID); err != nil {
		slog.Error("compact error", "device", c.DeviceID, "doc", docID, "error", err)
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

	// Check target user exists
	_, err = c.Queries.LookupUserByID(ctx, msg.TargetUserID)
	if err != nil {
		c.sendError("target user not found")
		return
	}

	inviteRole := msg.Role
	if inviteRole == "" {
		inviteRole = "editor"
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
			UserID:    m.UserID,
			Role:      m.Role,
			PublicKey: string(m.PublicKey),
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
	pk, err := c.Queries.LookupUserByID(ctx, msg.TargetUserID)
	if err != nil || pk == nil {
		c.sendError("user not found or no public key")
		return
	}
	c.sendJSON(ServerMessage{Type: "user_lookup", TargetUserID: msg.TargetUserID, TargetPublicKey: string(pk)})
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
		Type:    "role_changed",
		VaultID: msg.VaultID,
		NewRole: msg.NewRole,
	})
	c.Hub.Broadcast(msg.TargetUserID, "", relay)
}

func (c *Client) sendJSON(msg ServerMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("marshal error", "device", c.DeviceID, "error", err)
		return
	}
	select {
	case c.Send <- data:
	default:
		slog.Warn("send buffer full, dropping message", "device", c.DeviceID)
	}
}

func (c *Client) sendError(message string) {
	c.sendJSON(ServerMessage{Type: "error", Message: message})
}
