-- Add doc_id to scope sync messages per document (not per user)
ALTER TABLE sync_messages ADD COLUMN doc_id TEXT NOT NULL DEFAULT 'catalog';

-- Drop old constraints
ALTER TABLE sync_messages DROP CONSTRAINT sync_messages_user_id_seq_key;
DROP INDEX idx_sync_messages_user_id_seq;

-- New constraints scoped to user + document
ALTER TABLE sync_messages ADD CONSTRAINT sync_messages_user_doc_seq_key
  UNIQUE(user_id, doc_id, seq);
CREATE INDEX idx_sync_messages_user_doc_seq
  ON sync_messages(user_id, doc_id, seq);
