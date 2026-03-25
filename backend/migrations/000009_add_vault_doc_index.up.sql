CREATE INDEX IF NOT EXISTS idx_sync_messages_vault_doc_seq
  ON sync_messages (vault_id, doc_id, seq)
  WHERE vault_id IS NOT NULL;
