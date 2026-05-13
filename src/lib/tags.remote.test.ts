import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertDefined } from '../../test/assert-defined';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import { createConversation } from './server/conversations';
import { listTags, tagsForConversation } from './server/tags';
import * as remote from './tags.remote';

type AnyArgs = (...args: unknown[]) => Promise<unknown>;
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

async function expectRedirect(promise: Promise<unknown>, locationStartsWith: string) {
	try {
		await promise;
		throw new Error('expected redirect');
	} catch (e) {
		if (!isRedirect(e)) throw e;
		expect(e.location.startsWith(locationStartsWith)).toBe(true);
	}
}

async function expectError(promise: Promise<unknown>, status: number, msg?: RegExp) {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
		if (msg) expect(String(e.body.message)).toMatch(msg);
	}
}

// Helper for setup: a form action's redirect is expected, but we don't care
// where it redirects to. Swallows the redirect and re-throws anything else.
async function runForm(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch (e) {
		if (!isRedirect(e)) throw e;
	}
}

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
		await expectRedirect(addTag({ color: 'blue', name: 'work' }) as Promise<unknown>, '/settings');
		const tags = await listTags(env);
		const work = tags.find((t) => t.name === 'work');
		assertDefined(work);
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
		await expectRedirect(renameTagForm({ color: 'red', id, name: 'new' }) as Promise<unknown>, '/settings');
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
		await tagConversation({ attached: true, conversationId, tagId });
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

		await tagConversation({ attached: true, conversationId, tagId });
		await tagConversation({ attached: true, conversationId, tagId }); // idempotent
		expect((await tagsForConversation(env, conversationId)).length).toBe(1);

		await tagConversation({ attached: false, conversationId, tagId });
		await tagConversation({ attached: false, conversationId, tagId }); // idempotent
		expect(await tagsForConversation(env, conversationId)).toEqual([]);
	});

	it('rejects malformed conversation ids', async () => {
		await expectError(tagConversation({ attached: true, conversationId: 'bad', tagId: 1 }) as Promise<unknown>, 400);
	});

	it('rejects non-positive tag ids', async () => {
		const conversationId = await createConversation(env);
		await expectError(tagConversation({ attached: true, conversationId, tagId: 0 }) as Promise<unknown>, 400);
	});
});

describe('tags.remote — createAndTagConversation', () => {
	it('creates a tag and attaches it in a single call', async () => {
		const conversationId = await createConversation(env);
		const result = (await createAndTagConversation({ color: 'red', conversationId, name: 'urgent' })) as {
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
		await expectError(createAndTagConversation({ conversationId: 'bad', name: 'tag' }) as Promise<unknown>, 400);
	});

	it('rejects an empty name', async () => {
		const conversationId = await createConversation(env);
		await expectError(createAndTagConversation({ conversationId, name: '   ' }) as Promise<unknown>, 400);
	});
});
