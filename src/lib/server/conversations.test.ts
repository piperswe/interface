import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDefined } from '../../../test/assert-defined';
import {
	archiveConversation,
	createConversation,
	deleteConversation,
	getConversation,
	listArchivedConversations,
	listConversations,
	unarchiveConversation,
} from './conversations';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('conversations', () => {
	it('createConversation returns a UUID and inserts a row', async () => {
		const id = await createConversation(env);
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

		const row = await getConversation(env, id);
		expect(row).not.toBeNull();
		assertDefined(row);
		expect(row.id).toBe(id);
		expect(row.title).toBe('New conversation');
		expect(row.archived_at).toBeNull();
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

	it('archiveConversation excludes the row from listConversations', async () => {
		const a = await createConversation(env);
		const b = await createConversation(env);
		await archiveConversation(env, a);
		const list = await listConversations(env);
		expect(list.map((r) => r.id)).toEqual([b]);
	});

	it('archiveConversation stamps archived_at on the row', async () => {
		const a = await createConversation(env);
		await archiveConversation(env, a);
		const row = await getConversation(env, a);
		expect(row?.archived_at).toBeTypeOf('number');
		expect(row?.archived_at ?? 0).toBeGreaterThan(0);
	});

	it('listArchivedConversations returns archived rows sorted by archived_at DESC', async () => {
		const a = await createConversation(env);
		const b = await createConversation(env);
		await archiveConversation(env, a);
		await new Promise((r) => setTimeout(r, 5));
		await archiveConversation(env, b);
		const archived = await listArchivedConversations(env);
		expect(archived.map((r) => r.id)).toEqual([b, a]);
	});

	it('listArchivedConversations excludes active rows', async () => {
		const a = await createConversation(env);
		await createConversation(env);
		await archiveConversation(env, a);
		const archived = await listArchivedConversations(env);
		expect(archived.map((r) => r.id)).toEqual([a]);
	});

	it('unarchiveConversation restores the row to listConversations', async () => {
		const a = await createConversation(env);
		await archiveConversation(env, a);
		await unarchiveConversation(env, a);
		const active = await listConversations(env);
		const archived = await listArchivedConversations(env);
		expect(active.map((r) => r.id)).toEqual([a]);
		expect(archived).toEqual([]);
		const row = await getConversation(env, a);
		expect(row?.archived_at).toBeNull();
	});

	it('deleteConversation removes the row outright', async () => {
		const a = await createConversation(env);
		await deleteConversation(env, a);
		expect(await getConversation(env, a)).toBeNull();
		expect(await listConversations(env)).toEqual([]);
	});

	it('deleteConversation is a no-op for unknown ids', async () => {
		// Shouldn't throw.
		await deleteConversation(env, '00000000-0000-0000-0000-000000000000');
	});
});
