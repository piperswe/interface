// Named system-prompt presets ("Styles") selectable per conversation. Storage
// is D1; selection is stored as `conversations.style_id`. Mirrors
// `src/lib/server/sub_agents.ts`.

import { now as nowMs } from './clock';

const SINGLE_USER_ID = 1;

export type StyleRow = {
	id: number;
	name: string;
	systemPrompt: string;
	createdAt: number;
	updatedAt: number;
};

type Row = {
	id: number;
	name: string;
	system_prompt: string;
	created_at: number;
	updated_at: number;
};

function rowToStyle(r: Row): StyleRow {
	return {
		createdAt: r.created_at,
		id: r.id,
		name: r.name,
		systemPrompt: r.system_prompt,
		updatedAt: r.updated_at,
	};
}

export async function listStyles(env: Env, userId: number = SINGLE_USER_ID): Promise<StyleRow[]> {
	const result = await env.DB.prepare(
		`SELECT id, name, system_prompt, created_at, updated_at
		 FROM styles WHERE user_id = ? ORDER BY name`,
	)
		.bind(userId)
		.all<Row>();
	return (result.results ?? []).map(rowToStyle);
}

export async function getStyle(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<StyleRow | null> {
	const row = await env.DB.prepare(
		`SELECT id, name, system_prompt, created_at, updated_at
		 FROM styles WHERE id = ? AND user_id = ?`,
	)
		.bind(id, userId)
		.first<Row>();
	return row ? rowToStyle(row) : null;
}

export type CreateStyleInput = {
	name: string;
	systemPrompt: string;
};

export async function createStyle(env: Env, input: CreateStyleInput, userId: number = SINGLE_USER_ID): Promise<number> {
	if (!input.name.trim()) throw new Error('Name is required');
	if (!input.systemPrompt.trim()) throw new Error('System prompt is required');
	const now = nowMs();
	const result = await env.DB.prepare(
		`INSERT INTO styles (user_id, name, system_prompt, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 RETURNING id`,
	)
		.bind(userId, input.name.trim(), input.systemPrompt, now, now)
		.first<{ id: number }>();
	return result?.id ?? 0;
}

export type UpdateStyleInput = Partial<CreateStyleInput>;

export async function updateStyle(env: Env, id: number, input: UpdateStyleInput, userId: number = SINGLE_USER_ID): Promise<void> {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (input.name !== undefined) {
		if (!input.name.trim()) throw new Error('Name is required');
		sets.push('name = ?');
		values.push(input.name.trim());
	}
	if (input.systemPrompt !== undefined) {
		if (!input.systemPrompt.trim()) throw new Error('System prompt is required');
		sets.push('system_prompt = ?');
		values.push(input.systemPrompt);
	}
	if (sets.length === 0) return;
	sets.push('updated_at = ?');
	values.push(nowMs());
	values.push(id, userId);
	await env.DB.prepare(`UPDATE styles SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
		.bind(...values)
		.run();
}

export async function deleteStyle(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM styles WHERE id = ? AND user_id = ?').bind(id, userId).run();
	// Clear any conversation that referenced the deleted style.
	await env.DB.prepare('UPDATE conversations SET style_id = NULL WHERE style_id = ?').bind(id).run();
}
