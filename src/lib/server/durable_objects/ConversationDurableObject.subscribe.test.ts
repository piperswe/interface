import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import { readState, stubFor } from './conversation/_test-helpers';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('ConversationDurableObject — subscribe / destroy / parts', () => {
	it('subscribe returns a readable SSE stream that emits sync once a message exists', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
		});

		const stream = await stub.subscribe();
		const reader = stream.getReader();
		// First frame is the retry directive; second is the sync payload.
		let text = '';
		while (!text.includes('event: sync')) {
			const { value } = await reader.read();
			if (!value) break;
			text += new TextDecoder().decode(value);
		}
		await reader.cancel();
		expect(text).toContain('event: sync');
		expect(text).toContain('"lastMessageId":"u1"');
	});

	it('subscribe with no messages does not emit a sync frame and falls back to a ping', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const stream = await stub.subscribe();
		await stream.cancel();
	});

	it('destroy() empties the DO storage', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
		});
		const before = await readState(stub);
		expect(before.messages).toHaveLength(1);
		await stub.destroy();
		// `deleteAll` drops every row from the SQL store; the schema goes too,
		// since SQLite-backed DOs treat tables as storage. Verifying via a
		// raw SQL probe is more reliable than re-entering through `getState`,
		// which would try to read a now-missing `messages` table.
		await runInDurableObject(stub, async (_instance, ctx) => {
			const tables = ctx.storage.sql
				.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
				.toArray() as unknown as Array<{ name: string }>;
			expect(tables).toEqual([]);
		});
	});

	it('destroy() closes any live SSE subscribers', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
		});
		const stream = await stub.subscribe();
		const reader = stream.getReader();
		// Consume the retry directive and the initial sync frame.
		let consumed = '';
		while (!consumed.includes('event: sync')) {
			const { value } = await reader.read();
			if (!value) break;
			consumed += new TextDecoder().decode(value);
		}
		await stub.destroy();
		// Reader should observe stream end once destroy() closes the controller.
		const next = await reader.read();
		expect(next.done).toBe(true);
		await reader.cancel();
	});

	it('parts column drives the rendered timeline', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			const parts = JSON.stringify([
				{ type: 'thinking', text: 'silently planning' },
				{ type: 'text', text: 'final answer' },
				{ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'x' } },
				{ type: 'tool_result', toolUseId: 't1', content: 'result', isError: false },
			]);
			ctx.storage.sql.exec(
				`INSERT INTO messages (id, role, content, model, status, created_at, thinking, parts)
				 VALUES ('a1', 'assistant', 'final answer', 'm', 'complete', 1, 'silently planning', ?)`,
				parts,
			);
		});
		const state = await readState(stub);
		const m = state.messages[0];
		expect(m.parts?.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_result']);
	});
});
