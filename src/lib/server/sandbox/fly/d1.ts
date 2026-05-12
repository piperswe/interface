// D1 persistence for the fly backend. The preview route runs outside the
// Conversation DO and needs the machine id to set `fly-prefer-instance-id`,
// so this state lives in D1 (not the DO's per-conversation SQLite).

import { now as nowMs } from '$lib/server/clock';
import type { ExposedPort } from '../backend';

export async function getFlyMachineId(env: Env, conversationId: string): Promise<string | null> {
	const row = await env.DB.prepare(
		`SELECT external_id FROM conversation_sandbox WHERE conversation_id = ? AND backend = 'fly'`,
	)
		.bind(conversationId)
		.first<{ external_id: string | null }>();
	return row?.external_id ?? null;
}

export async function setFlyMachineId(
	env: Env,
	conversationId: string,
	machineId: string,
): Promise<void> {
	const now = nowMs();
	await env.DB.prepare(
		`INSERT INTO conversation_sandbox (conversation_id, backend, external_id, created_at, updated_at)
		 VALUES (?, 'fly', ?, ?, ?)
		 ON CONFLICT (conversation_id, backend) DO UPDATE
		 SET external_id = excluded.external_id, updated_at = excluded.updated_at`,
	)
		.bind(conversationId, machineId, now, now)
		.run();
}

export async function clearFlyMachineId(env: Env, conversationId: string): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM conversation_sandbox WHERE conversation_id = ? AND backend = 'fly'`,
	)
		.bind(conversationId)
		.run();
}

export async function recordExposedPort(
	env: Env,
	conversationId: string,
	port: number,
	token: string,
): Promise<void> {
	const now = nowMs();
	await env.DB.prepare(
		`INSERT INTO conversation_exposed_ports (conversation_id, port, token, created_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (conversation_id, port) DO UPDATE
		 SET token = excluded.token`,
	)
		.bind(conversationId, port, token, now)
		.run();
}

export async function listExposedPorts(
	env: Env,
	conversationId: string,
	hostname: string,
): Promise<ExposedPort[]> {
	const res = await env.DB.prepare(
		`SELECT port, token FROM conversation_exposed_ports WHERE conversation_id = ?`,
	)
		.bind(conversationId)
		.all<{ port: number; token: string }>();
	const rows = res.results ?? [];
	return rows.map((r) => ({
		port: r.port,
		url: `https://${r.port}-${conversationId}-${r.token}.${hostname}`,
	}));
}

export async function clearExposedPorts(env: Env, conversationId: string): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM conversation_exposed_ports WHERE conversation_id = ?`,
	)
		.bind(conversationId)
		.run();
}
