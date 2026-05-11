import { now as nowMs } from './clock';
import type { McpOauthState, McpServerRow } from './mcp/types';

const SINGLE_USER_ID = 1;

type Row = {
	id: number;
	name: string;
	transport: string;
	url: string | null;
	command: string | null;
	env_json: string | null;
	auth_json: string | null;
	enabled: number;
	user_id: number;
	oauth_authorization_server: string | null;
	oauth_authorization_endpoint: string | null;
	oauth_token_endpoint: string | null;
	oauth_registration_endpoint: string | null;
	oauth_client_id: string | null;
	oauth_client_secret: string | null;
	oauth_scopes: string | null;
	oauth_access_token: string | null;
	oauth_refresh_token: string | null;
	oauth_expires_at: number | null;
};

const SELECT_COLS = `id, name, transport, url, command, env_json, auth_json, enabled, user_id,
	oauth_authorization_server, oauth_authorization_endpoint, oauth_token_endpoint,
	oauth_registration_endpoint, oauth_client_id, oauth_client_secret, oauth_scopes,
	oauth_access_token, oauth_refresh_token, oauth_expires_at`;

function rowToOauth(r: Row): McpOauthState | null {
	const anySet =
		r.oauth_authorization_server ||
		r.oauth_authorization_endpoint ||
		r.oauth_token_endpoint ||
		r.oauth_client_id ||
		r.oauth_access_token ||
		r.oauth_refresh_token;
	if (!anySet) return null;
	return {
		authorizationServer: r.oauth_authorization_server,
		authorizationEndpoint: r.oauth_authorization_endpoint,
		tokenEndpoint: r.oauth_token_endpoint,
		registrationEndpoint: r.oauth_registration_endpoint,
		clientId: r.oauth_client_id,
		clientSecret: r.oauth_client_secret,
		scopes: r.oauth_scopes,
		accessToken: r.oauth_access_token,
		refreshToken: r.oauth_refresh_token,
		expiresAt: r.oauth_expires_at,
	};
}

function rowToServer(r: Row): McpServerRow {
	return {
		id: r.id,
		name: r.name,
		transport: r.transport as McpServerRow['transport'],
		url: r.url,
		command: r.command,
		envJson: r.env_json,
		authJson: r.auth_json,
		enabled: r.enabled === 1,
		oauth: rowToOauth(r),
	};
}

export async function listMcpServers(env: Env, userId: number = SINGLE_USER_ID): Promise<McpServerRow[]> {
	const result = await env.DB.prepare(
		`SELECT ${SELECT_COLS} FROM mcp_servers WHERE user_id = ? ORDER BY name`,
	)
		.bind(userId)
		.all<Row>();
	return (result.results ?? []).map(rowToServer);
}

export async function getMcpServer(env: Env, id: number): Promise<McpServerRow | null> {
	const row = await env.DB.prepare(
		`SELECT ${SELECT_COLS} FROM mcp_servers WHERE id = ?`,
	)
		.bind(id)
		.first<Row>();
	return row ? rowToServer(row) : null;
}

export type StoredOauthTokens = {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number | null;
};

export type SetTokensOptions = {
	// True for initial exchange (we want the operator to see the newly-
	// connected server enabled). False for background refresh, where we must
	// not silently revive a server the operator paused via `enabled = 0`.
	reEnable?: boolean;
};

export async function setMcpServerOauthTokens(
	env: Env,
	id: number,
	tokens: StoredOauthTokens,
	options: SetTokensOptions = {},
): Promise<void> {
	const reEnable = options.reEnable !== false;
	const sql = reEnable
		? `UPDATE mcp_servers
		 SET oauth_access_token = ?, oauth_refresh_token = ?, oauth_expires_at = ?, enabled = 1
		 WHERE id = ?`
		: `UPDATE mcp_servers
		 SET oauth_access_token = ?, oauth_refresh_token = ?, oauth_expires_at = ?
		 WHERE id = ?`;
	await env.DB.prepare(sql)
		.bind(tokens.accessToken, tokens.refreshToken, tokens.expiresAt, id)
		.run();
}

export type OauthClientRegistration = {
	authorizationServer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint: string | null;
	clientId: string;
	clientSecret: string | null;
	scopes: string | null;
};

export async function setMcpServerOauthClient(
	env: Env,
	id: number,
	reg: OauthClientRegistration,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE mcp_servers SET
			oauth_authorization_server = ?,
			oauth_authorization_endpoint = ?,
			oauth_token_endpoint = ?,
			oauth_registration_endpoint = ?,
			oauth_client_id = ?,
			oauth_client_secret = ?,
			oauth_scopes = ?
		 WHERE id = ?`,
	)
		.bind(
			reg.authorizationServer,
			reg.authorizationEndpoint,
			reg.tokenEndpoint,
			reg.registrationEndpoint,
			reg.clientId,
			reg.clientSecret,
			reg.scopes,
			id,
		)
		.run();
}

export type CreateMcpServerInput = {
	name: string;
	transport: 'http' | 'sse' | 'stdio';
	url?: string | null;
	command?: string | null;
	envJson?: string | null;
	authJson?: string | null;
};

export async function createMcpServer(
	env: Env,
	input: CreateMcpServerInput,
	userId: number = SINGLE_USER_ID,
): Promise<number> {
	const now = nowMs();
	const result = await env.DB.prepare(
		`INSERT INTO mcp_servers (user_id, name, transport, url, command, env_json, auth_json, enabled, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
		 RETURNING id`,
	)
		.bind(
			userId,
			input.name,
			input.transport,
			input.url ?? null,
			input.command ?? null,
			input.envJson ?? null,
			input.authJson ?? null,
			now,
		)
		.first<{ id: number }>();
	return result?.id ?? 0;
}

export async function deleteMcpServer(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?').bind(id, userId).run();
}

export async function setMcpServerEnabled(
	env: Env,
	id: number,
	enabled: boolean,
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	await env.DB.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ? AND user_id = ?')
		.bind(enabled ? 1 : 0, id, userId)
		.run();
}
