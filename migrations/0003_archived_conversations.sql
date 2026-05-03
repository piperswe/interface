-- Soft-archive flag for conversations. NULL = active, timestamp = the moment
-- the operator archived. Hard-deletes still remove the row outright.
ALTER TABLE conversations ADD COLUMN archived_at INTEGER NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_archived ON conversations(archived_at);
