import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation, getConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { createTag, addTagToConversation } from '$lib/server/tags';
import { expectError } from '../../../../test/helpers';
import { load } from './+page.server';

// Each test uses a fresh DO id so DO state from earlier tests can't leak in.
function freshId(): string {
	return crypto.randomUUID();
}

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversation_tags').run();
	await env.DB.prepare('DELETE FROM tags').run();
	await env.DB.prepare('DELETE FROM conversations').run();
});

type LoadEvent = Parameters<typeof load>[0];

function makeEvent(id: string, opts: { platform?: unknown } = {}): LoadEvent {
	return {
		params: { id },
		platform: 'platform' in opts ? opts.platform : { env },
	} as unknown as LoadEvent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadOk(event: LoadEvent): Promise<Record<string, any>> {
	const result = await load(event);
	if (!result) throw new Error('load returned void');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return result as Record<string, any>;
}

describe('c/[id]/+page.server.ts — load', () => {
	it('returns 404 on a malformed conversation id', async () => {
		await expectError(Promise.resolve(load(makeEvent('not-a-uuid'))), 404);
	});

	it('materialises a missing D1 row when the DO is empty (optimistic-creation race)', async () => {
		const id = freshId();
		expect(await getConversation(env, id)).toBeNull();
		const data = await loadOk(makeEvent(id));
		expect(data.conversation.id).toBe(id);
		// Row now exists in D1.
		expect(await getConversation(env, id)).not.toBeNull();
	});

	it('returns 404 when the DO has messages but the D1 row is absent', async () => {
		const id = freshId();
		// Seed messages directly into the DO without creating the D1 row —
		// simulates a hard-deleted conversation that hasn't been wiped from
		// the DO yet. The loader must NOT resurrect it.
		const stub = getConversationStub(env, id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, status, created_at) VALUES ('u1', 'user', 'hi', 'complete', 1)",
			);
		});
		await expectError(Promise.resolve(load(makeEvent(id))), 404);
	});

	it('returns the full payload for a normal conversation', async () => {
		const id = freshId();
		await createConversation(env, id);
		const tagId = await createTag(env, { name: 'project' });
		await addTagToConversation(env, id, tagId);
		const data = await loadOk(makeEvent(id));
		expect(data.conversation.id).toBe(id);
		expect(data.initialState.messages).toEqual([]);
		expect(Array.isArray(data.models)).toBe(true);
		expect(Array.isArray(data.styles)).toBe(true);
		expect((data.conversationTags as Array<{ id: number }>).map((t) => t.id)).toEqual([tagId]);
		expect(typeof data.kagiCostPer1000Searches).toBe('number');
		expect(data.defaultModel).toBe('');
	});

	it('passes thinkingBudget, styleId, and systemPromptOverride from the row', async () => {
		const id = freshId();
		await createConversation(env, id);
		await env.DB.prepare(
			'UPDATE conversations SET thinking_budget = ?, style_id = ?, system_prompt = ? WHERE id = ?',
		)
			.bind(8192, 5, 'be terse', id)
			.run();
		const data = await loadOk(makeEvent(id));
		expect(data.thinkingBudget).toBe(8192);
		expect(data.styleId).toBe(5);
		expect(data.systemPromptOverride).toBe('be terse');
	});

	it('returns 500 when platform is missing', async () => {
		await expectError(Promise.resolve(load(makeEvent(freshId(), { platform: undefined }))), 500);
	});
});
