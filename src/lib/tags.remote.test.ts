import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import { type AnyArgs, expectError, expectRedirect, runForm } from '../../test/helpers';
import * as remote from './tags.remote';
import { createConversation } from './server/conversations';
import { listTags, tagsForConversation } from './server/tags';

const addTag = remote.addTag as unknown as AnyArgs;
const renameTagForm = remote.renameTagForm as unknown as AnyArgs;
const removeTag = remote.removeTag as unknown as AnyArgs;
const tagConversation = remote.tagConversation as unknown as AnyArgs;
const createAndTagConversation = remote.createAndTagConversation as unknown as AnyArgs;

beforeEach(() => {
	setMockRequestEvent({ platform: { env } });
});

afterEach(async () => {
	clearMockRequestEvent();
	await env.DB.prepare('DELETE FROM conversation_tags').run();
	await env.DB.prepare('DELETE FROM tags').run();
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('tags.remote — addTag', () => {
	it('persists a tag and redirects to /settings by default', async () => {
		await expectRedirect(addTag({ name: 'work' }) as Promise<unknown>, '/settings');
		const tags = await listTags(env);
		expect(tags.map((t) => t.name)).toContain('work');
	});

	it('honours a redirectTo param', async () => {
		await expectRedirect(
			addTag({ name: 'work', redirectTo: '/c/abcd1234-abcd-1234-abcd-1234abcd1234' }) as Promise<unknown>,
			'/c/abcd1234-abcd-1234-abcd-1234abcd1234',
		);
	});

	it('persists a recognised color', async () => {
		await expectRedirect(addTag({ name: 'work', color: 'blue' }) as Promise<unknown>, '/settings');
		const tags = await listTags(env);
		const work = tags.find((t) => t.name === 'work')!;
		expect(work.color).toBe('blue');
	});

	it('rejects an empty name with 400', async () => {
		await expectError(addTag({ name: '   ' }) as Promise<unknown>, 400, /Tag name/);
	});
});

describe('tags.remote — renameTagForm', () => {
	it('renames a tag and updates its color', async () => {
		await runForm(addTag({ name: 'old' }));
		const id = (await listTags(env))[0].id;
		await expectRedirect(renameTagForm({ id, name: 'new', color: 'red' }) as Promise<unknown>, '/settings');
		const updated = (await listTags(env))[0];
		expect(updated.name).toBe('new');
		expect(updated.color).toBe('red');
	});

	it('rejects an invalid id', async () => {
		await expectError(renameTagForm({ id: 'abc' }) as Promise<unknown>, 400);
		await expectError(renameTagForm({ id: 0 }) as Promise<unknown>, 400);
	});
});

describe('tags.remote — removeTag', () => {
	it('deletes the row and detaches it from conversations (FK cascade)', async () => {
		const conversationId = await createConversation(env);
		await runForm(addTag({ name: 'project' }));
		const tagId = (await listTags(env))[0].id;
		await tagConversation({ conversationId, tagId, attached: true });
		expect((await tagsForConversation(env, conversationId)).map((t) => t.id)).toEqual([tagId]);
		await expectRedirect(removeTag({ id: tagId }) as Promise<unknown>, '/settings');
		expect(await listTags(env)).toEqual([]);
		expect(await tagsForConversation(env, conversationId)).toEqual([]);
	});

	it('rejects an invalid id', async () => {
		await expectError(removeTag({ id: 'foo' }) as Promise<unknown>, 400);
	});
});

describe('tags.remote — tagConversation', () => {
	it('attaches and detaches a tag idempotently', async () => {
		const conversationId = await createConversation(env);
		await runForm(addTag({ name: 'project' }));
		const tagId = (await listTags(env))[0].id;

		await tagConversation({ conversationId, tagId, attached: true });
		await tagConversation({ conversationId, tagId, attached: true }); // idempotent
		expect((await tagsForConversation(env, conversationId)).length).toBe(1);

		await tagConversation({ conversationId, tagId, attached: false });
		await tagConversation({ conversationId, tagId, attached: false }); // idempotent
		expect(await tagsForConversation(env, conversationId)).toEqual([]);
	});

	it('rejects malformed conversation ids', async () => {
		await expectError(
			tagConversation({ conversationId: 'bad', tagId: 1, attached: true }) as Promise<unknown>,
			400,
		);
	});

	it('rejects non-positive tag ids', async () => {
		const conversationId = await createConversation(env);
		await expectError(
			tagConversation({ conversationId, tagId: 0, attached: true }) as Promise<unknown>,
			400,
		);
	});
});

describe('tags.remote — createAndTagConversation', () => {
	it('creates a tag and attaches it in a single call', async () => {
		const conversationId = await createConversation(env);
		const result = (await createAndTagConversation({ conversationId, name: 'urgent', color: 'red' })) as {
			id: number;
		};
		expect(typeof result.id).toBe('number');
		expect(result.id).toBeGreaterThan(0);
		const attached = await tagsForConversation(env, conversationId);
		expect(attached.map((t) => t.name)).toEqual(['urgent']);
		expect(attached[0].color).toBe('red');
	});

	it('falls back to existing-tag lookup on a unique-name collision', async () => {
		const conversationId = await createConversation(env);
		// Pre-create the tag.
		await runForm(addTag({ name: 'duplicate' }));
		const existingId = (await listTags(env))[0].id;
		const result = (await createAndTagConversation({ conversationId, name: 'duplicate' })) as {
			id: number;
		};
		// The remote function should have surfaced the same id rather than throwing.
		expect(result.id).toBe(existingId);
		const attached = await tagsForConversation(env, conversationId);
		expect(attached.map((t) => t.id)).toEqual([existingId]);
	});

	it('rejects a malformed conversation id', async () => {
		await expectError(
			createAndTagConversation({ conversationId: 'bad', name: 'tag' }) as Promise<unknown>,
			400,
		);
	});

	it('rejects an empty name', async () => {
		const conversationId = await createConversation(env);
		await expectError(
			createAndTagConversation({ conversationId, name: '   ' }) as Promise<unknown>,
			400,
		);
	});
});
