import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation, getConversation, listConversations } from './conversations';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('conversations', () => {
	it('createConversation returns a UUID and inserts a row', async () => {
		const id = await createConversation(env);
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

		const row = await getConversation(env, id);
		expect(row).not.toBeNull();
		expect(row!.id).toBe(id);
		expect(row!.title).toBe('New conversation');
	});

	it('listConversations orders by updated_at DESC', async () => {
		const a = await createConversation(env);
		await new Promise((r) => setTimeout(r, 5));
		const b = await createConversation(env);
		await new Promise((r) => setTimeout(r, 5));
		const c = await createConversation(env);

		const list = await listConversations(env);
		expect(list.map((r) => r.id)).toEqual([c, b, a]);
	});

	it('getConversation returns null for unknown id', async () => {
		const row = await getConversation(env, '00000000-0000-0000-0000-000000000000');
		expect(row).toBeNull();
	});
});
