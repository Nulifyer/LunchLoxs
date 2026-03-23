CREATE TABLE users (
    user_id     TEXT PRIMARY KEY,
    auth_hash   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE devices (
    device_id   UUID PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_devices_user_id ON devices(user_id);

CREATE TABLE sync_messages (
    id          BIGSERIAL PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL,
    device_id   UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    payload     BYTEA NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, seq)
);
CREATE INDEX idx_sync_messages_user_id_seq ON sync_messages(user_id, seq);
