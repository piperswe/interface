// Persistent memory entries injected into the system prompt at generation
// start. Storage is D1; mirrors `src/lib/server/sub_agents.ts`.
//
// `type` distinguishes 'manual' entries (added by the user via Settings) from
// 'auto' entries (added by the LLM via the `remember` tool). `source` records
// where the entry came from (e.g. 'user', 'tool:remember').

import { now as nowMs } from './clock';

const SINGLE_USER_ID = 1;

export type MemoryRow = {
	id: number;
	type: 'manual' | 'auto';
	content: string;
	source: string;
	createdAt: number;
};

type Row = {
	id: number;
	type: string;
	content: string;
	source: string;
	created_at: number;
};

function rowToMemory(r: Row): MemoryRow {
	return {
		id: r.id,
		type: (r.type === 'auto' ? 'auto' : 'manual'),
		content: r.content,
		source: r.source,
		createdAt: r.created_at,
	};
}

export async function listMemories(env: Env, userId: number = SINGLE_USER_ID): Promise<MemoryRow[]> {
	const result = await env.DB.prepare(
		`SELECT id, type, content, source, created_at
		 FROM memories WHERE user_id = ? ORDER BY created_at DESC`,
	)
		.bind(userId)
		.all<Row>();
	return (result.results ?? []).map(rowToMemory);
}

export type CreateMemoryInput = {
	type: 'manual' | 'auto';
	content: string;
	source: string;
};

export async function createMemory(
	env: Env,
	input: CreateMemoryInput,
	userId: number = SINGLE_USER_ID,
): Promise<number> {
	const content = input.content.trim();
	if (!content) throw new Error('Memory content is required');
	const result = await env.DB.prepare(
		`INSERT INTO memories (user_id, type, content, source, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 RETURNING id`,
	)
		.bind(userId, input.type, content, input.source, nowMs())
		.first<{ id: number }>();
	return result?.id ?? 0;
}

export async function deleteMemory(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').bind(id, userId).run();
}
