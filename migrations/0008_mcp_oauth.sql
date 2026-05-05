-- OAuth 2.1 (per the MCP authorization spec) support for MCP servers.
-- New columns on mcp_servers carry the discovered authorization-server
-- metadata, the (possibly dynamically registered) client credentials, and the
-- stored access/refresh token. A separate `mcp_oauth_state` table holds
-- short-lived in-progress flow state (PKCE verifier + CSRF state).

ALTER TABLE mcp_servers ADD COLUMN oauth_authorization_server TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_authorization_endpoint TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_token_endpoint TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_registration_endpoint TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_client_id TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_client_secret TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_scopes TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_access_token TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_refresh_token TEXT NULL;
ALTER TABLE mcp_servers ADD COLUMN oauth_expires_at INTEGER NULL;

CREATE TABLE IF NOT EXISTS mcp_oauth_state (
	state TEXT PRIMARY KEY,
	server_id INTEGER NOT NULL,
	code_verifier TEXT NOT NULL,
	redirect_uri TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_state_server ON mcp_oauth_state(server_id);
