-- Sub-agents: operator-defined specialised agents that the main conversation
-- can delegate to via a built-in `agent` tool. Each sub-agent runs its own
-- LLM loop with a custom system prompt and a curated tool subset.
--
-- `tools_json` is either NULL (sub-agent inherits the parent's built-in tools)
-- or a JSON array of tool names to allow (e.g. `["fetch_url","web_search"]`).
-- Sub-agents never have access to the `agent` tool itself — recursion would
-- be unbounded and the model would lose track of the original task.
--
-- `model` is optional; when NULL the parent conversation's model is reused.
-- `max_iterations` caps the inner agent loop independently of the parent.
CREATE TABLE IF NOT EXISTS sub_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  model TEXT NULL,
  max_iterations INTEGER NULL,
  tools_json TEXT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sub_agents_user ON sub_agents(user_id);
