ALTER TABLE users ADD COLUMN IF NOT EXISTS signing_public_key BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wrapped_signing_private_key BYTEA;
