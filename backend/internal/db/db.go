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
	Seq       int64
	DeviceID  string
	Payload   []byte
	CreatedAt time.Time
}

type Queries struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Queries {
	return &Queries{pool: pool}
}

// UpsertUser creates a user if not exists, or verifies auth_hash if exists.
// Returns true if auth succeeded, false if wrong credentials.
func (q *Queries) UpsertUser(ctx context.Context, userID, authHash string) (bool, error) {
	var existingHash string
	err := q.pool.QueryRow(ctx,
		`SELECT auth_hash FROM users WHERE user_id = $1`, userID,
	).Scan(&existingHash)

	if err == pgx.ErrNoRows {
		// New user — create
		_, err = q.pool.Exec(ctx,
			`INSERT INTO users (user_id, auth_hash) VALUES ($1, $2)`,
			userID, authHash,
		)
		return err == nil, err
	}
	if err != nil {
		return false, err
	}

	// Existing user — verify (constant-time compare would be better, but
	// auth_hash is already a SHA-256 hex digest, not the raw secret)
	return existingHash == authHash, nil
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

// StoreMessage stores an encrypted sync message and returns the assigned sequence number.
func (q *Queries) StoreMessage(ctx context.Context, userID, deviceID string, payload []byte) (int64, error) {
	var seq int64
	err := q.pool.QueryRow(ctx,
		`INSERT INTO sync_messages (user_id, seq, device_id, payload)
		 VALUES ($1, COALESCE((SELECT MAX(seq) FROM sync_messages WHERE user_id = $1), 0) + 1, $2, $3)
		 RETURNING seq`,
		userID, deviceID, payload,
	).Scan(&seq)
	return seq, err
}

// GetMessagesSince returns all messages for a user with seq > afterSeq.
func (q *Queries) GetMessagesSince(ctx context.Context, userID string, afterSeq int64) ([]SyncMessage, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, user_id, seq, device_id, payload, created_at
		 FROM sync_messages
		 WHERE user_id = $1 AND seq > $2
		 ORDER BY seq ASC`,
		userID, afterSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (SyncMessage, error) {
		var m SyncMessage
		err := row.Scan(&m.ID, &m.UserID, &m.Seq, &m.DeviceID, &m.Payload, &m.CreatedAt)
		return m, err
	})
}
