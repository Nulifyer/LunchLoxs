package db

import (
	"context"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type SyncMessage struct {
	ID        int64
	UserID    string
	DocID     string
	Seq       int64
	DeviceID  string
	Payload   []byte
	CreatedAt time.Time
}

// AuthResult contains the result of user authentication.
type AuthResult struct {
	OK                       bool
	IsNew                    bool
	WrappedMasterKey         []byte
	PublicKey                []byte
	SigningPublicKey          []byte
	WrappedSigningPrivateKey []byte
}

// VaultInfo represents a vault and the user's access to it.
type VaultInfo struct {
	VaultID           string
	EncryptedVaultKey []byte
	SenderPublicKey   []byte
	Role              string
	CreatedBy         string
}

// VaultMember represents a member of a vault.
type VaultMember struct {
	UserID           string
	Role             string
	PublicKey        []byte
	SigningPublicKey []byte
}

// VaultKeyUpdate holds the re-encrypted vault key for a single member during key rotation.
type VaultKeyUpdate struct {
	UserID            string
	EncryptedVaultKey []byte
	SenderPublicKey   []byte
}

type Queries struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Queries {
	return &Queries{pool: pool}
}

// UpsertUser authenticates or creates a user.
// If isSignup is true, the user must not already exist.
// If isSignup is false, the user must exist and the auth hash must match.
func (q *Queries) UpsertUser(ctx context.Context, userID, authHash string, isSignup bool) (AuthResult, error) {
	var existingHash string
	var wrappedKey []byte
	var publicKey []byte
	var signingPublicKey []byte
	err := q.pool.QueryRow(ctx,
		`SELECT auth_hash, wrapped_master_key, public_key, signing_public_key FROM users WHERE user_id = $1`, userID,
	).Scan(&existingHash, &wrappedKey, &publicKey, &signingPublicKey)

	if err == pgx.ErrNoRows {
		if !isSignup {
			return AuthResult{}, fmt.Errorf("user_not_found")
		}
		_, err = q.pool.Exec(ctx,
			`INSERT INTO users (user_id, auth_hash) VALUES ($1, $2)`,
			userID, authHash,
		)
		return AuthResult{OK: err == nil, IsNew: true}, err
	}
	if err != nil {
		return AuthResult{}, err
	}

	if isSignup {
		return AuthResult{}, fmt.Errorf("user_already_exists")
	}

	hashMatch := subtle.ConstantTimeCompare([]byte(existingHash), []byte(authHash)) == 1

	return AuthResult{
		OK:                       hashMatch,
		IsNew:                    false,
		WrappedMasterKey:         wrappedKey,
		PublicKey:                publicKey,
		SigningPublicKey:          signingPublicKey,
		WrappedSigningPrivateKey: nil,
	}, nil
}

// UpsertDevice registers or updates a device for a user.
func (q *Queries) UpsertDevice(ctx context.Context, deviceID, userID string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO devices (device_id, user_id)
		 VALUES ($1, $2)
		 ON CONFLICT (device_id) DO UPDATE SET last_seen = NOW()`,
		deviceID, userID,
	)
	return err
}

// SetWrappedMasterKey stores the encrypted master key for a user.
func (q *Queries) SetWrappedMasterKey(ctx context.Context, userID string, wrappedKey []byte) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET wrapped_master_key = $2 WHERE user_id = $1`,
		userID, wrappedKey,
	)
	return err
}

// StoreMessage stores an encrypted sync message scoped to a user+document (personal docs).
// Returns the assigned sequence number.
func (q *Queries) StoreMessage(ctx context.Context, userID, docID, deviceID string, payload []byte) (int64, error) {
	var seq int64
	err := q.pool.QueryRow(ctx,
		`INSERT INTO sync_messages (user_id, doc_id, seq, device_id, payload)
		 VALUES ($1, $2, COALESCE((SELECT MAX(seq) FROM sync_messages WHERE user_id = $1 AND doc_id = $2), 0) + 1, $3, $4)
		 RETURNING seq`,
		userID, docID, deviceID, payload,
	).Scan(&seq)
	return seq, err
}

// StoreVaultMessage stores a sync message scoped to a vault+document (shared docs).
// Sequencing is by vault_id + doc_id so all members share the same sequence space.
func (q *Queries) StoreVaultMessage(ctx context.Context, vaultID, docID, userID, deviceID string, payload []byte) (int64, error) {
	var seq int64
	err := q.pool.QueryRow(ctx,
		`INSERT INTO sync_messages (user_id, doc_id, seq, device_id, payload, vault_id)
		 VALUES ($1, $2, COALESCE((SELECT MAX(seq) FROM sync_messages WHERE vault_id = $4 AND doc_id = $2), 0) + 1, $3, $5, $4)
		 RETURNING seq`,
		userID, docID, deviceID, vaultID, payload,
	).Scan(&seq)
	return seq, err
}

// CompactDocument removes all but the latest snapshot for a user+document.
func (q *Queries) CompactDocument(ctx context.Context, userID, docID string) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM sync_messages
		 WHERE user_id = $1 AND doc_id = $2
		 AND seq < (SELECT MAX(seq) FROM sync_messages WHERE user_id = $1 AND doc_id = $2)`,
		userID, docID,
	)
	return err
}

// CompactVaultDocument removes all but the latest snapshot for a vault+document.
func (q *Queries) CompactVaultDocument(ctx context.Context, vaultID, docID string) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM sync_messages
		 WHERE vault_id = $1 AND doc_id = $2
		 AND seq < (SELECT MAX(seq) FROM sync_messages WHERE vault_id = $1 AND doc_id = $2)`,
		vaultID, docID,
	)
	return err
}

// GetMessagesSince returns all messages for a user+document with seq > afterSeq.
func (q *Queries) GetMessagesSince(ctx context.Context, userID, docID string, afterSeq int64) ([]SyncMessage, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, user_id, doc_id, seq, device_id, payload, created_at
		 FROM sync_messages
		 WHERE user_id = $1 AND doc_id = $2 AND seq > $3
		 ORDER BY seq ASC`,
		userID, docID, afterSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (SyncMessage, error) {
		var m SyncMessage
		err := row.Scan(&m.ID, &m.UserID, &m.DocID, &m.Seq, &m.DeviceID, &m.Payload, &m.CreatedAt)
		return m, err
	})
}

// GetVaultMessagesSince returns all messages for a vault+document with seq > afterSeq.
func (q *Queries) GetVaultMessagesSince(ctx context.Context, vaultID, docID string, afterSeq int64) ([]SyncMessage, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, user_id, doc_id, seq, device_id, payload, created_at
		 FROM sync_messages
		 WHERE vault_id = $1 AND doc_id = $2 AND seq > $3
		 ORDER BY seq ASC`,
		vaultID, docID, afterSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (SyncMessage, error) {
		var m SyncMessage
		err := row.Scan(&m.ID, &m.UserID, &m.DocID, &m.Seq, &m.DeviceID, &m.Payload, &m.CreatedAt)
		return m, err
	})
}

// GetVaultMemberIDs returns just the user IDs for a vault.
func (q *Queries) GetVaultMemberIDs(ctx context.Context, vaultID string) ([]string, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT user_id FROM vault_members WHERE vault_id = $1`, vaultID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (string, error) {
		var uid string
		err := row.Scan(&uid)
		return uid, err
	})
}

// UpdateAuthHash updates a user's auth hash (for password change).
func (q *Queries) UpdateAuthHash(ctx context.Context, userID, newAuthHash string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET auth_hash = $2 WHERE user_id = $1`,
		userID, newAuthHash,
	)
	return err
}

// SetIdentityKeys stores the user's public key and encrypted private key.
func (q *Queries) SetIdentityKeys(ctx context.Context, userID string, publicKey, wrappedPrivateKey []byte) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET public_key = $2, wrapped_private_key = $3 WHERE user_id = $1`,
		userID, publicKey, wrappedPrivateKey,
	)
	return err
}

// SetSigningKeys stores the user's signing public key and encrypted signing private key.
func (q *Queries) SetSigningKeys(ctx context.Context, userID string, signingPublicKey, wrappedSigningPrivateKey []byte) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET signing_public_key = $2, wrapped_signing_private_key = $3 WHERE user_id = $1`,
		userID, signingPublicKey, wrappedSigningPrivateKey,
	)
	return err
}

// GetPublicKey returns a user's public key by user_id.
func (q *Queries) GetPublicKey(ctx context.Context, userID string) ([]byte, error) {
	var pk []byte
	err := q.pool.QueryRow(ctx, `SELECT public_key FROM users WHERE user_id = $1`, userID).Scan(&pk)
	return pk, err
}

// GetWrappedPrivateKey returns the user's encrypted private key.
func (q *Queries) GetWrappedPrivateKey(ctx context.Context, userID string) ([]byte, error) {
	var wpk []byte
	err := q.pool.QueryRow(ctx, `SELECT wrapped_private_key FROM users WHERE user_id = $1`, userID).Scan(&wpk)
	return wpk, err
}

// GetWrappedSigningPrivateKey returns the user's encrypted signing private key.
func (q *Queries) GetWrappedSigningPrivateKey(ctx context.Context, userID string) ([]byte, error) {
	var wsk []byte
	err := q.pool.QueryRow(ctx, `SELECT wrapped_signing_private_key FROM users WHERE user_id = $1`, userID).Scan(&wsk)
	return wsk, err
}

// CreateVault creates a new vault and adds the creator as owner.
func (q *Queries) CreateVault(ctx context.Context, vaultID, creatorUserID string, encryptedVaultKey, senderPublicKey []byte) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx,
		`INSERT INTO vaults (vault_id, created_by) VALUES ($1, $2)`,
		vaultID, creatorUserID,
	)
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO vault_members (vault_id, user_id, encrypted_vault_key, sender_public_key, role, invited_by)
		 VALUES ($1, $2, $3, $4, 'owner', $2)`,
		vaultID, creatorUserID, encryptedVaultKey, senderPublicKey,
	)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// ListVaults returns all vaults a user is a member of.
func (q *Queries) ListVaults(ctx context.Context, userID string) ([]VaultInfo, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT vm.vault_id, vm.encrypted_vault_key, vm.sender_public_key, vm.role, v.created_by
		 FROM vault_members vm
		 JOIN vaults v ON v.vault_id = vm.vault_id
		 WHERE vm.user_id = $1
		 ORDER BY v.created_at ASC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (VaultInfo, error) {
		var v VaultInfo
		err := row.Scan(&v.VaultID, &v.EncryptedVaultKey, &v.SenderPublicKey, &v.Role, &v.CreatedBy)
		return v, err
	})
}

// AddVaultMember adds a user to a vault with an encrypted vault key.
func (q *Queries) AddVaultMember(ctx context.Context, vaultID, userID string, encryptedVaultKey, senderPublicKey []byte, role, invitedBy string) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO vault_members (vault_id, user_id, encrypted_vault_key, sender_public_key, role, invited_by)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (vault_id, user_id) DO UPDATE SET encrypted_vault_key = $3, sender_public_key = $4, role = $5`,
		vaultID, userID, encryptedVaultKey, senderPublicKey, role, invitedBy,
	)
	return err
}

// RemoveVaultMember removes a user from a vault.
func (q *Queries) RemoveVaultMember(ctx context.Context, vaultID, userID string) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM vault_members WHERE vault_id = $1 AND user_id = $2`,
		vaultID, userID,
	)
	return err
}

// ListVaultMembers returns all members of a vault.
func (q *Queries) ListVaultMembers(ctx context.Context, vaultID string) ([]VaultMember, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT vm.user_id, vm.role, u.public_key, u.signing_public_key
		 FROM vault_members vm
		 JOIN users u ON u.user_id = vm.user_id
		 WHERE vm.vault_id = $1`,
		vaultID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (VaultMember, error) {
		var m VaultMember
		err := row.Scan(&m.UserID, &m.Role, &m.PublicKey, &m.SigningPublicKey)
		return m, err
	})
}

// IsVaultMember checks if a user is a member of a vault.
func (q *Queries) IsVaultMember(ctx context.Context, vaultID, userID string) (bool, string, error) {
	var role string
	err := q.pool.QueryRow(ctx,
		`SELECT role FROM vault_members WHERE vault_id = $1 AND user_id = $2`,
		vaultID, userID,
	).Scan(&role)
	if err == pgx.ErrNoRows {
		return false, "", nil
	}
	return err == nil, role, err
}

// DeleteVault deletes a vault and all its members and sync messages.
func (q *Queries) DeleteVault(ctx context.Context, vaultID string) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx, `DELETE FROM sync_messages WHERE vault_id = $1`, vaultID)
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `DELETE FROM vaults WHERE vault_id = $1`, vaultID)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// LookupUserByID checks if a user_id exists and returns their public key and signing public key.
func (q *Queries) LookupUserByID(ctx context.Context, userID string) (pubKey []byte, signingPubKey []byte, err error) {
	err = q.pool.QueryRow(ctx, `SELECT public_key, signing_public_key FROM users WHERE user_id = $1`, userID).Scan(&pubKey, &signingPubKey)
	return pubKey, signingPubKey, err
}

// PurgeUser deletes all vault memberships, owned empty vaults, sync messages, devices, and the user record.
func (q *Queries) PurgeUser(ctx context.Context, userID string) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// 1. Remove user from all vault memberships
	_, err = tx.Exec(ctx, `DELETE FROM vault_members WHERE user_id = $1`, userID)
	if err != nil {
		return fmt.Errorf("delete vault_members: %w", err)
	}

	// 2. Find owned vaults that now have no remaining members
	// (we already removed this user's memberships, so empty = truly empty)
	rows, err := tx.Query(ctx,
		`SELECT v.vault_id FROM vaults v
		 WHERE v.created_by = $1
		 AND NOT EXISTS (SELECT 1 FROM vault_members vm WHERE vm.vault_id = v.vault_id)`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("find empty vaults: %w", err)
	}
	var emptyVaultIDs []string
	for rows.Next() {
		var vid string
		if err := rows.Scan(&vid); err != nil {
			rows.Close()
			return fmt.Errorf("scan vault_id: %w", err)
		}
		emptyVaultIDs = append(emptyVaultIDs, vid)
	}
	rows.Close()

	// 3. Delete sync_messages for empty vaults, then delete the vaults
	// (sync_messages.vault_id FK cascades, but explicit delete avoids FK issues with ordering)
	for _, vid := range emptyVaultIDs {
		_, err = tx.Exec(ctx, `DELETE FROM sync_messages WHERE vault_id = $1`, vid)
		if err != nil {
			return fmt.Errorf("delete sync_messages for vault %s: %w", vid, err)
		}
	}
	for _, vid := range emptyVaultIDs {
		_, err = tx.Exec(ctx, `DELETE FROM vaults WHERE vault_id = $1`, vid)
		if err != nil {
			return fmt.Errorf("delete vault %s: %w", vid, err)
		}
	}

	// 4. For owned vaults with remaining members, transfer created_by to another member
	_, err = tx.Exec(ctx,
		`UPDATE vaults SET created_by = (
			SELECT vm.user_id FROM vault_members vm WHERE vm.vault_id = vaults.vault_id LIMIT 1
		) WHERE created_by = $1`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("transfer vault ownership: %w", err)
	}

	// 5. Delete user's personal sync_messages (non-vault-scoped)
	_, err = tx.Exec(ctx, `DELETE FROM sync_messages WHERE user_id = $1 AND vault_id IS NULL`, userID)
	if err != nil {
		return fmt.Errorf("delete personal sync_messages: %w", err)
	}

	// 6. Delete devices
	_, err = tx.Exec(ctx, `DELETE FROM devices WHERE user_id = $1`, userID)
	if err != nil {
		return fmt.Errorf("delete devices: %w", err)
	}

	// 7. Delete user (no more FK references should point to this user)
	_, err = tx.Exec(ctx, `DELETE FROM users WHERE user_id = $1`, userID)
	if err != nil {
		return fmt.Errorf("delete user: %w", err)
	}

	return tx.Commit(ctx)
}

// TransferOwnership transfers vault ownership from currentOwner to newOwner.
func (q *Queries) TransferOwnership(ctx context.Context, vaultID, currentOwnerID, newOwnerID string) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Verify current owner
	var currentRole string
	err = tx.QueryRow(ctx,
		`SELECT role FROM vault_members WHERE vault_id = $1 AND user_id = $2`,
		vaultID, currentOwnerID,
	).Scan(&currentRole)
	if err != nil {
		return fmt.Errorf("current owner not found: %w", err)
	}
	if currentRole != "owner" {
		return fmt.Errorf("user %s is not the owner", currentOwnerID)
	}

	// Verify new owner is a member
	var newRole string
	err = tx.QueryRow(ctx,
		`SELECT role FROM vault_members WHERE vault_id = $1 AND user_id = $2`,
		vaultID, newOwnerID,
	).Scan(&newRole)
	if err != nil {
		return fmt.Errorf("new owner is not a member: %w", err)
	}

	// Demote current owner to editor
	_, err = tx.Exec(ctx,
		`UPDATE vault_members SET role = 'editor' WHERE vault_id = $1 AND user_id = $2`,
		vaultID, currentOwnerID,
	)
	if err != nil {
		return err
	}

	// Promote new owner
	_, err = tx.Exec(ctx,
		`UPDATE vault_members SET role = 'owner' WHERE vault_id = $1 AND user_id = $2`,
		vaultID, newOwnerID,
	)
	if err != nil {
		return err
	}

	// Update vaults.created_by
	_, err = tx.Exec(ctx,
		`UPDATE vaults SET created_by = $2 WHERE vault_id = $1`,
		vaultID, newOwnerID,
	)
	if err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// ChangeRole updates a vault member's role.
func (q *Queries) ChangeRole(ctx context.Context, vaultID, targetUserID, newRole string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE vault_members SET role = $3 WHERE vault_id = $1 AND user_id = $2`,
		vaultID, targetUserID, newRole,
	)
	return err
}

// CountVaultOwners returns the number of owners in a vault.
func (q *Queries) CountVaultOwners(ctx context.Context, vaultID string) (int, error) {
	var count int
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM vault_members WHERE vault_id = $1 AND role = 'owner'`,
		vaultID,
	).Scan(&count)
	return count, err
}

// GetVaultOwner returns the user_id of an owner of the vault.
func (q *Queries) GetVaultOwner(ctx context.Context, vaultID string) (string, error) {
	var ownerID string
	err := q.pool.QueryRow(ctx,
		`SELECT user_id FROM vault_members WHERE vault_id = $1 AND role = 'owner' LIMIT 1`,
		vaultID,
	).Scan(&ownerID)
	return ownerID, err
}

// RotateVaultKeys atomically updates the encrypted vault key for every member of a vault.
func (q *Queries) RotateVaultKeys(ctx context.Context, vaultID string, updates []VaultKeyUpdate) error {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, u := range updates {
		_, err = tx.Exec(ctx,
			`UPDATE vault_members SET encrypted_vault_key = $3, sender_public_key = $4 WHERE vault_id = $1 AND user_id = $2`,
			vaultID, u.UserID, u.EncryptedVaultKey, u.SenderPublicKey)
		if err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// Ensure slog is used (compile-time check).
var _ = slog.Info
