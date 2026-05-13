import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDefined } from '../../../test/assert-defined';
import { createConversation } from './conversations';
import {
	addTagToConversation,
	createTag,
	deleteTag,
	isValidColor,
	listTags,
	removeTagFromConversation,
	renameTag,
	TAG_COLORS,
	tagsForConversation,
	tagsForConversations,
} from './tags';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversation_tags').run();
	await env.DB.prepare('DELETE FROM tags').run();
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('isValidColor', () => {
	it('accepts every entry in TAG_COLORS', () => {
		for (const c of TAG_COLORS) expect(isValidColor(c)).toBe(true);
	});
	it('rejects unknown color names', () => {
		expect(isValidColor('rainbow')).toBe(false);
		expect(isValidColor('')).toBe(false);
	});
	it('rejects null/undefined/non-string', () => {
		expect(isValidColor(null)).toBe(false);
		expect(isValidColor(undefined)).toBe(false);
		// Force-pass a non-string.
		expect(isValidColor(7 as unknown as string)).toBe(false);
	});
	it('TAG_COLORS exposes the canonical palette in a predictable order', () => {
		expect(TAG_COLORS).toEqual(['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']);
	});
});

describe('createTag + listTags', () => {
	it('round-trips a tag through create + list + listTags ordering', async () => {
		const id1 = await createTag(env, { name: 'work' });
		const id2 = await createTag(env, { color: 'pink', name: 'personal' });
		expect(id1).toBeGreaterThan(0);
		expect(id2).toBeGreaterThan(0);
		expect(id2).not.toBe(id1);
		const rows = await listTags(env);
		// listTags orders by name ascending.
		expect(rows.map((r) => r.name)).toEqual(['personal', 'work']);
		// `color` defaults to null when not provided.
		const work = rows.find((r) => r.name === 'work');
		const personal = rows.find((r) => r.name === 'personal');
		assertDefined(work);
		assertDefined(personal);
		expect(work.color).toBeNull();
		expect(personal.color).toBe('pink');
		expect(work.createdAt).toBeGreaterThan(0);
	});

	it('trims the name', async () => {
		await createTag(env, { name: '   spacey   ' });
		const rows = await listTags(env);
		expect(rows[0].name).toBe('spacey');
	});

	it('rejects an empty / whitespace-only name', async () => {
		await expect(createTag(env, { name: '' })).rejects.toThrow(/required/);
		await expect(createTag(env, { name: '   ' })).rejects.toThrow(/required/);
	});

	it('rejects names longer than 64 characters', async () => {
		await expect(createTag(env, { name: 'x'.repeat(65) })).rejects.toThrow(/too long/);
		// 64 is allowed.
		await expect(createTag(env, { name: 'x'.repeat(64) })).resolves.toBeGreaterThan(0);
	});

	it('coerces an unknown color to null', async () => {
		const id = await createTag(env, { color: 'magenta', name: 'odd' });
		const rows = await listTags(env);
		expect(rows.find((r) => r.id === id)?.color).toBeNull();
	});

	it('isolates rows per user_id', async () => {
		await createTag(env, { name: 'a' }, 1);
		await createTag(env, { name: 'b' }, 2);
		expect((await listTags(env, 1)).map((t) => t.name)).toEqual(['a']);
		expect((await listTags(env, 2)).map((t) => t.name)).toEqual(['b']);
	});
});

describe('renameTag', () => {
	it('renames the tag and updates color independently', async () => {
		const id = await createTag(env, { color: 'red', name: 'old' });
		await renameTag(env, id, { name: 'new' });
		expect((await listTags(env)).find((r) => r.id === id)).toMatchObject({ color: 'red', name: 'new' });
		await renameTag(env, id, { color: 'blue' });
		expect((await listTags(env)).find((r) => r.id === id)).toMatchObject({ color: 'blue', name: 'new' });
	});

	it('clears the color when set to null', async () => {
		const id = await createTag(env, { color: 'red', name: 'x' });
		await renameTag(env, id, { color: null });
		expect((await listTags(env)).find((r) => r.id === id)?.color).toBeNull();
	});

	it('coerces an unknown color to null on rename', async () => {
		const id = await createTag(env, { color: 'red', name: 'x' });
		await renameTag(env, id, { color: 'magenta' });
		expect((await listTags(env)).find((r) => r.id === id)?.color).toBeNull();
	});

	it('is a no-op when input has no fields', async () => {
		const id = await createTag(env, { color: 'red', name: 'x' });
		await renameTag(env, id, {});
		expect((await listTags(env)).find((r) => r.id === id)).toMatchObject({ color: 'red', name: 'x' });
	});

	it('rejects an empty new name', async () => {
		const id = await createTag(env, { name: 'x' });
		await expect(renameTag(env, id, { name: '   ' })).rejects.toThrow(/required/);
	});

	it("is scoped by user_id (does not rename another user's tag)", async () => {
		const id = await createTag(env, { name: 'shared' }, 1);
		await renameTag(env, id, { name: 'hijacked' }, 2);
		expect((await listTags(env, 1)).find((r) => r.id === id)?.name).toBe('shared');
	});
});

describe('deleteTag', () => {
	it('deletes the row and cascades attachments via FK', async () => {
		const conversationId = await createConversation(env);
		const tagId = await createTag(env, { name: 'work' });
		await addTagToConversation(env, conversationId, tagId);
		expect((await tagsForConversation(env, conversationId)).map((t) => t.id)).toEqual([tagId]);
		await deleteTag(env, tagId);
		expect(await listTags(env)).toEqual([]);
		// FK cascade should clear the join row too.
		expect(await tagsForConversation(env, conversationId)).toEqual([]);
	});

	it('is scoped by user_id', async () => {
		const id = await createTag(env, { name: 'mine' }, 1);
		await deleteTag(env, id, 2); // wrong user — no-op
		expect(await listTags(env, 1)).toHaveLength(1);
		await deleteTag(env, id, 1);
		expect(await listTags(env, 1)).toHaveLength(0);
	});
});

describe('addTagToConversation / removeTagFromConversation', () => {
	it('addTagToConversation is idempotent (INSERT OR IGNORE)', async () => {
		const conversationId = await createConversation(env);
		const tagId = await createTag(env, { name: 'work' });
		await addTagToConversation(env, conversationId, tagId);
		await addTagToConversation(env, conversationId, tagId);
		expect((await tagsForConversation(env, conversationId)).map((t) => t.id)).toEqual([tagId]);
	});

	it('removeTagFromConversation is idempotent and only removes the named pair', async () => {
		const conversationId = await createConversation(env);
		const tagA = await createTag(env, { name: 'a' });
		const tagB = await createTag(env, { name: 'b' });
		await addTagToConversation(env, conversationId, tagA);
		await addTagToConversation(env, conversationId, tagB);
		await removeTagFromConversation(env, conversationId, tagA);
		const remaining = await tagsForConversation(env, conversationId);
		expect(remaining.map((t) => t.id)).toEqual([tagB]);
		// Removing again is a no-op.
		await removeTagFromConversation(env, conversationId, tagA);
	});

	it('tagsForConversation orders by tag name', async () => {
		const conversationId = await createConversation(env);
		const idZ = await createTag(env, { name: 'z' });
		const idA = await createTag(env, { name: 'a' });
		await addTagToConversation(env, conversationId, idZ);
		await addTagToConversation(env, conversationId, idA);
		expect((await tagsForConversation(env, conversationId)).map((t) => t.name)).toEqual(['a', 'z']);
	});
});

describe('tagsForConversations', () => {
	it('returns an empty map when no ids are passed', async () => {
		const m = await tagsForConversations(env, []);
		expect(m.size).toBe(0);
	});

	it('returns a map keyed by conversation_id, ordered by tag name', async () => {
		const c1 = await createConversation(env);
		const c2 = await createConversation(env);
		const tagWork = await createTag(env, { name: 'work' });
		const tagPersonal = await createTag(env, { name: 'personal' });
		await addTagToConversation(env, c1, tagWork);
		await addTagToConversation(env, c1, tagPersonal);
		await addTagToConversation(env, c2, tagWork);
		const m = await tagsForConversations(env, [c1, c2]);
		expect(m.get(c1)?.map((t) => t.name)).toEqual(['personal', 'work']);
		expect(m.get(c2)?.map((t) => t.name)).toEqual(['work']);
	});

	it('omits conversations that have no tags', async () => {
		const c1 = await createConversation(env);
		const c2 = await createConversation(env);
		const tag = await createTag(env, { name: 'x' });
		await addTagToConversation(env, c1, tag);
		const m = await tagsForConversations(env, [c1, c2]);
		expect(m.has(c1)).toBe(true);
		expect(m.has(c2)).toBe(false);
	});
});
