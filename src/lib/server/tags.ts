// Conversation tags (folders / labels). Many-to-many: one conversation can
// carry multiple tags, one tag can apply to many conversations. The sidebar
// uses these to group / filter the conversation list and a quick-tag
// dropdown on the conversation header lets the operator add or remove tags
// without leaving the chat.

import { now as nowMs } from './clock';

const SINGLE_USER_ID = 1;

export type Tag = {
	id: number;
	name: string;
	color: string | null;
	createdAt: number;
};

type TagRow = {
	id: number;
	name: string;
	color: string | null;
	created_at: number;
};

function rowToTag(r: TagRow): Tag {
	return { id: r.id, name: r.name, color: r.color, createdAt: r.created_at };
}

const ALLOWED_COLORS = new Set(['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']);

export function isValidColor(c: string | null | undefined): c is string {
	return typeof c === 'string' && ALLOWED_COLORS.has(c);
}

export const TAG_COLORS = [...ALLOWED_COLORS];

export async function listTags(env: Env, userId: number = SINGLE_USER_ID): Promise<Tag[]> {
	const result = await env.DB.prepare(
		`SELECT id, name, color, created_at FROM tags WHERE user_id = ? ORDER BY name`,
	)
		.bind(userId)
		.all<TagRow>();
	return (result.results ?? []).map(rowToTag);
}

export async function createTag(
	env: Env,
	input: { name: string; color?: string | null },
	userId: number = SINGLE_USER_ID,
): Promise<number> {
	const name = input.name.trim();
	if (!name) throw new Error('Tag name is required');
	if (name.length > 64) throw new Error('Tag name too long');
	const color = isValidColor(input.color ?? null) ? input.color! : null;
	const result = await env.DB.prepare(
		`INSERT INTO tags (user_id, name, color, created_at)
		 VALUES (?, ?, ?, ?)
		 RETURNING id`,
	)
		.bind(userId, name, color, nowMs())
		.first<{ id: number }>();
	return result?.id ?? 0;
}

export async function deleteTag(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').bind(id, userId).run();
	// conversation_tags rows cascade via FK ON DELETE CASCADE.
}

export async function renameTag(
	env: Env,
	id: number,
	input: { name?: string; color?: string | null },
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (input.name !== undefined) {
		const name = input.name.trim();
		if (!name) throw new Error('Tag name is required');
		sets.push('name = ?');
		values.push(name);
	}
	if (input.color !== undefined) {
		const c = isValidColor(input.color ?? null) ? input.color : null;
		sets.push('color = ?');
		values.push(c);
	}
	if (sets.length === 0) return;
	values.push(id, userId);
	await env.DB.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
		.bind(...values)
		.run();
}

export async function tagsForConversation(env: Env, conversationId: string): Promise<Tag[]> {
	const result = await env.DB.prepare(
		`SELECT t.id, t.name, t.color, t.created_at
		   FROM conversation_tags ct
		   JOIN tags t ON t.id = ct.tag_id
		  WHERE ct.conversation_id = ?
		  ORDER BY t.name`,
	)
		.bind(conversationId)
		.all<TagRow>();
	return (result.results ?? []).map(rowToTag);
}

// Returns a map of conversation_id -> Tag[] for the given conversation ids.
// One round-trip; used to render tag chips in the sidebar list.
export async function tagsForConversations(env: Env, conversationIds: string[]): Promise<Map<string, Tag[]>> {
	const map = new Map<string, Tag[]>();
	if (conversationIds.length === 0) return map;
	const placeholders = conversationIds.map(() => '?').join(',');
	type Row = TagRow & { conversation_id: string };
	const result = await env.DB.prepare(
		`SELECT ct.conversation_id, t.id, t.name, t.color, t.created_at
		   FROM conversation_tags ct
		   JOIN tags t ON t.id = ct.tag_id
		  WHERE ct.conversation_id IN (${placeholders})
		  ORDER BY t.name`,
	)
		.bind(...conversationIds)
		.all<Row>();
	for (const r of result.results ?? []) {
		const list = map.get(r.conversation_id) ?? [];
		list.push(rowToTag(r));
		map.set(r.conversation_id, list);
	}
	return map;
}

export async function addTagToConversation(env: Env, conversationId: string, tagId: number): Promise<void> {
	await env.DB.prepare(
		`INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id, created_at)
		 VALUES (?, ?, ?)`,
	)
		.bind(conversationId, tagId, nowMs())
		.run();
}

export async function removeTagFromConversation(env: Env, conversationId: string, tagId: number): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?`,
	)
		.bind(conversationId, tagId)
		.run();
}
