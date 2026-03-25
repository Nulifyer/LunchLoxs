CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users
CREATE TABLE users (
    user_id                    TEXT PRIMARY KEY,
    auth_hash                  TEXT NOT NULL,
    wrapped_master_key         BYTEA,
    public_key                 BYTEA,
    wrapped_private_key        BYTEA,
    signing_public_key         BYTEA,
    wrapped_signing_private_key BYTEA,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Devices
CREATE TABLE devices (
    device_id   UUID PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_devices_user_id ON devices(user_id);

-- Vaults
CREATE TABLE vaults (
    vault_id    TEXT PRIMARY KEY,
    created_by  TEXT NOT NULL REFERENCES users(user_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vault_members (
    vault_id            TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    encrypted_vault_key BYTEA NOT NULL,
    sender_public_key   BYTEA,
    role                TEXT NOT NULL DEFAULT 'editor',
    invited_by          TEXT REFERENCES users(user_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vault_id, user_id)
);

-- Sync messages (vault + document scoped)
CREATE TABLE sync_messages (
    id          BIGSERIAL PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    vault_id    TEXT REFERENCES vaults(vault_id) ON DELETE CASCADE,
    doc_id      TEXT NOT NULL DEFAULT 'catalog',
    seq         BIGINT NOT NULL,
    device_id   UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    payload     BYTEA NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, doc_id, seq)
);
CREATE INDEX idx_sync_messages_user_doc_seq ON sync_messages(user_id, doc_id, seq);
CREATE INDEX idx_sync_messages_vault_doc_seq ON sync_messages(vault_id, doc_id, seq) WHERE vault_id IS NOT NULL;
