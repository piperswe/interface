import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { expectError } from '../../../../../test/helpers';
import { GET } from './+server';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

async function callGet(conversationId: string, opts?: { platform?: unknown }): Promise<Response> {
	const url = new URL(`http://localhost/c/${conversationId}/events`);
	const event = {
		params: { id: conversationId },
		url,
		platform: opts && 'platform' in opts ? opts.platform : { env },
		request: new Request(url.toString()),
	} as Parameters<typeof GET>[0];
	return GET(event);
}

describe('events +server.ts — GET (SSE proxy)', () => {
	it('rejects malformed conversation ids with 404', async () => {
		await expectError(callGet('not-a-uuid'), 404);
	});

	it('returns 500 when platform is missing', async () => {
		await expectError(
			callGet('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { platform: undefined }),
			500,
		);
	});

	it('proxies the DO subscribe stream as text/event-stream with caching disabled', async () => {
		const id = await createConversation(env);
		// Seed a message so the DO emits a sync frame on subscribe.
		const stub = getConversationStub(env, id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
		});

		const res = await callGet(id);
		expect(res.headers.get('Content-Type')).toBe('text/event-stream');
		expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
		expect(res.headers.get('X-Accel-Buffering')).toBe('no');
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (!buffer.includes('event: sync')) {
			const { value, done } = await reader.read();
			if (value) buffer += decoder.decode(value, { stream: true });
			if (done) break;
		}
		await reader.cancel();
		expect(buffer).toContain('retry: 3000');
		expect(buffer).toContain('event: sync');
		expect(buffer).toContain('"lastMessageId":"u1"');
	});
});
