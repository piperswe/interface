import type { Conversation } from './types/conversation';

export type { Conversation };

export async function listConversations(env: Env): Promise<Conversation[]> {
	const result = await env.DB.prepare(
		`SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 200`,
	).all<Conversation>();
	return result.results ?? [];
}

export async function createConversation(env: Env): Promise<string> {
	const id = crypto.randomUUID();
	const now = Date.now();
	await env.DB.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'New conversation', ?, ?)`)
		.bind(id, now, now)
		.run();
	return id;
}

export async function getConversation(env: Env, id: string): Promise<Conversation | null> {
	const row = await env.DB.prepare(`SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?`)
		.bind(id)
		.first<Conversation>();
	return row ?? null;
}
