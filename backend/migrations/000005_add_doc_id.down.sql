ALTER TABLE sync_messages DROP CONSTRAINT IF EXISTS sync_messages_user_doc_seq_key;
DROP INDEX IF EXISTS idx_sync_messages_user_doc_seq;

ALTER TABLE sync_messages DROP COLUMN IF EXISTS doc_id;

ALTER TABLE sync_messages ADD CONSTRAINT sync_messages_user_id_seq_key
  UNIQUE(user_id, seq);
CREATE INDEX idx_sync_messages_user_id_seq
  ON sync_messages(user_id, seq);
