-- Conversation full-text search (FTS5).
--
-- One row per (conversation, message) plus one synthetic row per conversation
-- title (message_id = '__title__'). The DO writes message rows on user-message
-- insert and assistant-message completion. Title rows are written by D1 code
-- on conversation create / title regeneration.
--
-- The `porter` tokenizer matches words like "scheduling" / "schedule" /
-- "scheduled"; `unicode61` lowercases and strips diacritics. `remove_diacritics 2`
-- handles a few extra Unicode normalisations.
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search USING fts5(
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  role UNINDEXED,
  created_at UNINDEXED,
  text,
  tokenize = "porter unicode61 remove_diacritics 2"
);

-- Backfill titles for any pre-existing conversations so the search palette
-- isn't empty on day one. Message bodies are populated on the next DO write
-- per conversation; existing assistant turns can be reindexed by opening the
-- conversation (the DO has a `reindexSearch` RPC).
INSERT INTO conversation_search (conversation_id, message_id, role, created_at, text)
SELECT id, '__title__', 'title', updated_at, title
FROM conversations
WHERE archived_at IS NULL;

-- Tags: many-to-many with conversations. `color` is a CSS-friendly hint for
-- the chip swatch ('blue', 'green', etc.) — left nullable so we can default.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id);

CREATE TABLE IF NOT EXISTS conversation_tags (
  conversation_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, tag_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_tags_tag ON conversation_tags(tag_id);

-- Scheduled prompts. The Scheduler Durable Object scans this table on its
-- alarm fire and runs each due schedule by posting `prompt` as a user message
-- to `target_conversation_id` (creating a new conversation when null).
--
-- recurrence: 'hourly' | 'daily' | 'weekly' (we keep this enumerated rather
-- than parse cron — three buckets cover the listed use cases). `time_of_day`
-- is minutes-from-midnight UTC for daily/weekly; `day_of_week` is 0=Sunday
-- for weekly. `next_run_at` is recomputed after every fire.
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  recurrence TEXT NOT NULL,
  time_of_day INTEGER NULL,
  day_of_week INTEGER NULL,
  target_conversation_id TEXT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
