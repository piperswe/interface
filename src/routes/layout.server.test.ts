import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '$lib/server/conversations';
import { createTag, addTagToConversation } from '$lib/server/tags';
import { load } from './+layout.server';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversation_tags').run();
	await env.DB.prepare('DELETE FROM tags').run();
	await env.DB.prepare('DELETE FROM conversations').run();
});

type LoadEvent = Parameters<typeof load>[0];

function makeEvent(opts: { platform?: unknown; theme?: string } = {}): LoadEvent {
	return {
		platform: 'platform' in opts ? opts.platform : { env },
		locals: { theme: opts.theme ?? 'auto' },
	} as unknown as LoadEvent;
}

async function expectError(promise: Promise<unknown>, status: number): Promise<void> {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
	}
}

// SvelteKit's load type widens to `void | PageData & Record<string, any>`; in
// tests we always run the real function which returns the data, so narrow.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadOk(event: LoadEvent): Promise<Record<string, any>> {
	const result = await load(event);
	if (!result) throw new Error('load returned void');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return result as Record<string, any>;
}

describe('+layout.server.ts — load', () => {
	it('returns 500 when platform is missing', async () => {
		await expectError(Promise.resolve(load(makeEvent({ platform: null }))), 500);
	});

	it('returns conversations, tags, conversationTags map, and the locals theme', async () => {
		const a = await createConversation(env);
		const b = await createConversation(env);
		const tagId = await createTag(env, { name: 'work', color: 'blue' });
		await addTagToConversation(env, a, tagId);

		const data = await loadOk(makeEvent({ theme: 'dark' }));
		expect(data.theme).toBe('dark');
		expect((data.conversations as Array<{ id: string }>).map((c) => c.id).sort()).toEqual([a, b].sort());
		expect((data.tags as Array<{ name: string }>).map((t) => t.name)).toEqual(['work']);
		// Tag map: keyed by conversation id, values are arrays of tag ids.
		expect(data.conversationTags[a]).toEqual([tagId]);
		expect(data.conversationTags[b]).toBeUndefined();
	});

	it('returns empty arrays when there are no conversations', async () => {
		const data = await loadOk(makeEvent());
		expect(data.conversations).toEqual([]);
		expect(data.tags).toEqual([]);
		expect(data.conversationTags).toEqual({});
	});
});
