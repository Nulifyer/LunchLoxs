CREATE TABLE blobs (
    vault_id   TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
    checksum   TEXT NOT NULL,
    data       BYTEA NOT NULL,
    mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
    filename   TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vault_id, checksum)
);
