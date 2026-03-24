CREATE TABLE IF NOT EXISTS vaults (
    vault_id    TEXT PRIMARY KEY,
    created_by  TEXT NOT NULL REFERENCES users(user_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vault_members (
    vault_id            TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    encrypted_vault_key BYTEA NOT NULL,
    role                TEXT NOT NULL DEFAULT 'editor',
    invited_by          TEXT REFERENCES users(user_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vault_id, user_id)
);

-- Scope sync_messages to vaults
ALTER TABLE sync_messages ADD COLUMN IF NOT EXISTS vault_id TEXT REFERENCES vaults(vault_id) ON DELETE CASCADE;
