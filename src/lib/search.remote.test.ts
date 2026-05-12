import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import * as remote from './search.remote';
import { createConversation } from './server/conversations';
import { indexMessage, indexTitle } from './server/search';

type AnyArgs = (...args: unknown[]) => Promise<unknown>;
const searchConversations = remote.searchConversations as unknown as AnyArgs;

type SearchHit = {
	conversationId: string;
	conversationTitle: string;
	messageId: string | null;
	role: 'title' | 'user' | 'assistant';
	snippet: string;
	createdAt: number;
};

beforeEach(() => {
	setMockRequestEvent({ platform: { env } });
});

afterEach(async () => {
	clearMockRequestEvent();
	await env.DB.prepare('DELETE FROM conversation_search').run();
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('search.remote — searchConversations', () => {
	it('returns an empty array for empty input', async () => {
		expect(await searchConversations('')).toEqual([]);
	});

	it('returns an empty array for whitespace-only input', async () => {
		expect(await searchConversations('   \t  ')).toEqual([]);
	});

	it('rejects non-string input via the Zod schema', async () => {
		// Regression: ensure the schema-level guard rejects non-strings now that
		// `query(z.string(), ...)` does the type check (we no longer return `[]`
		// silently for bad input).
		await expect(searchConversations(42 as unknown as string)).rejects.toMatchObject({
			status: 400,
		});
	});

	it('finds a conversation by its title', async () => {
		const id = await createConversation(env);
		// Update both the FTS index and the row's title so the JOIN-ed
		// `conversationTitle` matches what we indexed.
		await env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?')
			.bind('birthday cake recipe', id)
			.run();
		await indexTitle(env, id, 'birthday cake recipe', 1000);
		const hits = (await searchConversations('birthday')) as SearchHit[];
		expect(hits.map((h) => h.conversationId)).toContain(id);
		const hit = hits.find((h) => h.conversationId === id)!;
		expect(hit.conversationTitle).toBe('birthday cake recipe');
		expect(hit.role).toBe('title');
		expect(hit.messageId).toBeNull();
	});

	it('finds a conversation by an indexed message body', async () => {
		const id = await createConversation(env);
		await indexMessage(env, {
			conversationId: id,
			messageId: 'm1',
			role: 'user',
			text: 'how do I deploy a Cloudflare Worker',
			createdAt: 5000,
		});
		const hits = (await searchConversations('Cloudflare')) as SearchHit[];
		const messageHit = hits.find((h) => h.messageId === 'm1');
		expect(messageHit).toBeTruthy();
		expect(messageHit?.role).toBe('user');
		expect(messageHit?.snippet).toContain('Cloudflare');
		expect(messageHit?.snippet).toContain('<mark>');
	});

	it('skips archived conversations', async () => {
		const id = await createConversation(env);
		await indexTitle(env, id, 'pirates and ninjas', 1000);
		// Archive — search should now exclude it.
		await env.DB.prepare('UPDATE conversations SET archived_at = 9999 WHERE id = ?').bind(id).run();
		const hits = (await searchConversations('pirates')) as SearchHit[];
		expect(hits.find((h) => h.conversationId === id)).toBeUndefined();
	});

	it('caps results to the limit (30)', async () => {
		// Seed 35 conversations whose titles all match the query.
		for (let i = 0; i < 35; i++) {
			const id = await createConversation(env);
			await indexTitle(env, id, `widget ${i} discussion`, 1000 + i);
		}
		const hits = (await searchConversations('widget')) as SearchHit[];
		expect(hits.length).toBeLessThanOrEqual(30);
		expect(hits.length).toBeGreaterThan(0);
	});
});
