-- User-defined tools backed by Cloudflare Worker Loader.
--
-- Each row is one tool the agent can call. `source` is a full ES module that
-- exports a default `WorkerEntrypoint` subclass with an async `run(input)`
-- method; `secrets_json` is passed as the loaded worker's `env` so the source
-- can reference `this.env.X` for per-tool API keys. `input_schema` is the
-- JSON Schema sent to the LLM so it knows the shape of `input`.
--
-- The runner caches loaded isolates by `id + sha256(source)` so edits
-- transparently invalidate the cache.
CREATE TABLE IF NOT EXISTS custom_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  secrets_json TEXT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_custom_tools_user ON custom_tools(user_id);
