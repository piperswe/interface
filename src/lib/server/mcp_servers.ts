import { now as nowMs } from './clock';
import type { McpServerRow } from './mcp/types';

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
};

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
	};
}

export async function listMcpServers(env: Env, userId: number = SINGLE_USER_ID): Promise<McpServerRow[]> {
	const result = await env.DB.prepare(
		`SELECT id, name, transport, url, command, env_json, auth_json, enabled, user_id
		 FROM mcp_servers WHERE user_id = ? ORDER BY name`,
	)
		.bind(userId)
		.all<Row>();
	return (result.results ?? []).map(rowToServer);
}

export async function getMcpServer(env: Env, id: number): Promise<McpServerRow | null> {
	const row = await env.DB.prepare(
		`SELECT id, name, transport, url, command, env_json, auth_json, enabled, user_id
		 FROM mcp_servers WHERE id = ?`,
	)
		.bind(id)
		.first<Row>();
	return row ? rowToServer(row) : null;
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
