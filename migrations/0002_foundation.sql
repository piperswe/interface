-- Foundation migration: tables and columns required for the multi-provider LLM
-- interface, settings, styles, memory, and MCP server registry.
-- See plan: Phase 0a in /Users/pmc/.claude/plans/implement-the-prd-from-cozy-bengio.md.

-- Stub users table. Populated with id=1 in single-user mode; replaced by real
-- auth records in Phase 6 (multi-user). user_id columns elsewhere are nullable
-- for now and become NOT NULL with the Phase 6 backfill migration.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO users (id, created_at) VALUES (1, unixepoch() * 1000);

-- Per-user key/value settings bag (theme, default model, etc.).
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Named system-prompt presets ("Styles") selectable per conversation.
CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_styles_user ON styles(user_id);

-- Persistent memory entries injected into the system prompt at generation start.
-- project_id nullable from day one for forward-compat with Phase 4 projects.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);

-- Operator-configured MCP servers.
-- transport: 'http' | 'sse' | 'stdio' (stdio handled by Sandbox in Phase 0.6).
CREATE TABLE IF NOT EXISTS mcp_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  url TEXT NULL,
  command TEXT NULL,
  env_json TEXT NULL,
  auth_json TEXT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id);

-- New columns on conversations. user_id nullable in v1; backfilled NOT NULL in Phase 6.
ALTER TABLE conversations ADD COLUMN user_id INTEGER NULL;
ALTER TABLE conversations ADD COLUMN style_id INTEGER NULL;
ALTER TABLE conversations ADD COLUMN thinking_budget INTEGER NULL;
