package db

import (
	"context"
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
	OK               bool
	IsNew            bool
	WrappedMasterKey []byte
}

type Queries struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Queries {
	return &Queries{pool: pool}
}

// UpsertUser creates a user if not exists, or verifies auth_hash if exists.
func (q *Queries) UpsertUser(ctx context.Context, userID, authHash string) (AuthResult, error) {
	var existingHash string
	var wrappedKey []byte
	err := q.pool.QueryRow(ctx,
		`SELECT auth_hash, wrapped_master_key FROM users WHERE user_id = $1`, userID,
	).Scan(&existingHash, &wrappedKey)

	if err == pgx.ErrNoRows {
		_, err = q.pool.Exec(ctx,
			`INSERT INTO users (user_id, auth_hash) VALUES ($1, $2)`,
			userID, authHash,
		)
		return AuthResult{OK: err == nil, IsNew: true}, err
	}
	if err != nil {
		return AuthResult{}, err
	}

	return AuthResult{
		OK:               existingHash == authHash,
		IsNew:            false,
		WrappedMasterKey: wrappedKey,
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

// StoreMessage stores an encrypted sync message scoped to a document.
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

// CompactDocument removes all but the latest snapshot for a user+document.
// Safe because each push is a full Automerge snapshot.
func (q *Queries) CompactDocument(ctx context.Context, userID, docID string) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM sync_messages
		 WHERE user_id = $1 AND doc_id = $2
		 AND seq < (SELECT MAX(seq) FROM sync_messages WHERE user_id = $1 AND doc_id = $2)`,
		userID, docID,
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

// UpdateAuthHash updates a user's auth hash (for password change).
func (q *Queries) UpdateAuthHash(ctx context.Context, userID, newAuthHash string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE users SET auth_hash = $2 WHERE user_id = $1`,
		userID, newAuthHash,
	)
	return err
}

// PurgeUser deletes all sync messages, devices, and the user record.
func (q *Queries) PurgeUser(ctx context.Context, userID string) error {
	_, err := q.pool.Exec(ctx, `DELETE FROM sync_messages WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	_, err = q.pool.Exec(ctx, `DELETE FROM devices WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	_, err = q.pool.Exec(ctx, `DELETE FROM users WHERE user_id = $1`, userID)
	return err
}
