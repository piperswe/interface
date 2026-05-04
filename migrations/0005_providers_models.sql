-- Provider and model configuration tables. Replaces the JSON model_list setting
-- with a normalized relational schema. Each provider has an API type, optional
-- credentials/endpoint, and optional gateway id. Models belong to a provider and
-- carry display metadata plus a max context length for compaction.

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('anthropic', 'openai_compatible')),
  api_key TEXT,
  endpoint TEXT,
  gateway_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_providers_user ON providers(user_id);

CREATE TABLE IF NOT EXISTS provider_models (
  id TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  max_context_length INTEGER NOT NULL DEFAULT 128000,
  reasoning_type TEXT CHECK(reasoning_type IN ('effort', 'max_tokens') OR reasoning_type IS NULL),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider_id, id)
);
CREATE INDEX IF NOT EXISTS idx_provider_models_user ON provider_models(user_id);
