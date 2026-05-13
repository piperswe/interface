import type { Conversation } from '$lib/types/conversation';
import { now, uuid } from './clock';
import { indexTitle, unindexConversation } from './search';

export type { Conversation };

const SELECT_COLS = 'id, title, created_at, updated_at, thinking_budget, archived_at, style_id, system_prompt';

export async function listConversations(env: Env): Promise<Conversation[]> {
	const result = await env.DB.prepare(
		`SELECT ${SELECT_COLS} FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 200`,
	).all<Conversation>();
	return result.results ?? [];
}

export async function listArchivedConversations(env: Env): Promise<Conversation[]> {
	const result = await env.DB.prepare(
		`SELECT ${SELECT_COLS} FROM conversations WHERE archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT 200`,
	).all<Conversation>();
	return result.results ?? [];
}

// Insert a `conversations` row. Accepts an optional id so the client can
// pre-allocate one for optimistic navigation; `INSERT OR IGNORE` makes the
// call idempotent across the optimistic-creation race (the loader may also
// materialise the same id if the user lands on `/c/<id>` before the
// background create resolves).
export async function createConversation(env: Env, id: string = uuid()): Promise<string> {
	const ts = now();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at, thinking_budget) VALUES (?, 'New conversation', ?, ?, 4096)`,
	)
		.bind(id, ts, ts)
		.run();
	await indexTitle(env, id, 'New conversation', ts);
	return id;
}

export async function getConversation(env: Env, id: string): Promise<Conversation | null> {
	const row = await env.DB.prepare(`SELECT ${SELECT_COLS} FROM conversations WHERE id = ?`).bind(id).first<Conversation>();
	return row ?? null;
}

export async function archiveConversation(env: Env, id: string): Promise<void> {
	await env.DB.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').bind(now(), id).run();
}

export async function unarchiveConversation(env: Env, id: string): Promise<void> {
	await env.DB.prepare('UPDATE conversations SET archived_at = NULL WHERE id = ?').bind(id).run();
}

// Hard-delete the conversation row. The Durable Object's storage is cleared
// separately via `stub.destroy()` — DOs in Cloudflare can't truly be removed
// from the namespace, but `ctx.storage.deleteAll()` drops every row inside
// them so the next time the DO wakes it's empty.
export async function deleteConversation(env: Env, id: string): Promise<void> {
	await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(id).run();
	await unindexConversation(env, id);
}
