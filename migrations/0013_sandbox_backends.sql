-- Pluggable sandbox backends.
--
-- `conversation_sandbox` maps a conversation to its backend-specific
-- external id. For the Cloudflare backend the row is implicit (the DO
-- namespace already keys by conversationId, so external_id is NULL).
-- For the fly backend it stores the fly Machine id so the preview route
-- can set `fly-prefer-instance-id` without first calling the Machines
-- API.
--
-- Composite PK (conversation_id, backend) lets a conversation carry rows
-- for multiple backends if a user toggles the setting; the unused row is
-- cleaned up on destroy.
CREATE TABLE IF NOT EXISTS conversation_sandbox (
  conversation_id TEXT NOT NULL,
  backend         TEXT NOT NULL CHECK (backend IN ('cloudflare','fly')),
  external_id     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, backend)
);

-- Records each port the conversation has exposed via the fly backend,
-- so `getExposedPorts` can return the list (fly has no native exposed-
-- ports registry the way the Cloudflare Sandbox SDK does). Cloudflare's
-- backend ignores this table.
--
-- We deliberately do not store `hostname` here: the URL template is
-- reconstructed at read time from the caller-supplied hostname, so the
-- stored value would never be read. A port-token tuple is the entire
-- per-port state.
CREATE TABLE IF NOT EXISTS conversation_exposed_ports (
  conversation_id TEXT NOT NULL,
  port            INTEGER NOT NULL,
  token           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, port)
);
