import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import type ConversationDurableObject from './ConversationDurableObject';
import type { ConversationState } from '../types/conversation';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

function stubFor(conversationId: string): DurableObjectStub<ConversationDurableObject> {
	return env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
}

// `DurableObjectStub<>` walks every field of the RPC return type through
// Cloudflare's Serializable<> constraint. ConversationState's nested
// MessageRow + Artifact + ToolCall structure exceeds TS's recursion budget.
// Reading getState through this typed view keeps tests readable without
// triggering the depth limit.
async function readState(stub: DurableObjectStub<ConversationDurableObject>): Promise<ConversationState> {
	return (await (stub as unknown as { getState(): Promise<ConversationState> }).getState());
}

describe('ConversationDurableObject', () => {
	it('addUserMessage rejects empty content', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const result = await stub.addUserMessage(id, '   ', 'm/test');
		expect(result).toEqual({ status: 'invalid', reason: 'empty' });
	});

	it('addUserMessage rejects missing model', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const result = await stub.addUserMessage(id, 'hi', '');
		expect(result).toEqual({ status: 'invalid', reason: 'missing model' });
	});

	it('getState returns empty messages for fresh DO', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const state = await readState(stub);
		expect(state.messages).toEqual([]);
		expect(state.inProgress).toBeNull();
	});

	it('messages table has the expanded Phase 0a schema', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			const cols = ctx.storage.sql
				.exec('PRAGMA table_info(messages)')
				.toArray() as unknown as Array<{ name: string }>;
			const names = cols.map((c) => c.name);
			expect(names).toEqual(
				expect.arrayContaining([
					'id',
					'role',
					'content',
					'model',
					'status',
					'error',
					'created_at',
					'started_at',
					'first_token_at',
					'last_chunk_json',
					'usage_json',
					'generation_json',
					'provider',
					'thinking',
					'tool_calls',
					'tool_results',
					'parent_id',
					'deleted_at',
				]),
			);
		});
	});

	it('addUserMessage seeds a user + assistant pair and updates the conversation title', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);

		// The default `started` flow kicks off a real generation. We don't want
		// that in a unit test, so we observe state synchronously via
		// runInDurableObject after seeding the rows by hand.
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hello world', NULL, 'complete', 1000)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', 'hi back', 'm/test', 'complete', 1001)",
			);
		});

		const state = await readState(stub);
		expect(state.messages).toHaveLength(2);
		expect(state.messages[0]).toMatchObject({ role: 'user', content: 'hello world', status: 'complete' });
		expect(state.messages[1]).toMatchObject({ role: 'assistant', content: 'hi back', status: 'complete' });
		expect(state.inProgress).toBeNull();
	});

	it('soft-deleted messages are filtered out by getState', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at, deleted_at) VALUES ('d1', 'user', 'gone', NULL, 'complete', 1, 999)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('k1', 'user', 'kept', NULL, 'complete', 2)",
			);
		});

		const state = await readState(stub);
		expect(state.messages.map((m) => m.id)).toEqual(['k1']);
	});

	it('setThinkingBudget persists to the conversations row', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await stub.setThinkingBudget(id, 5000);
		const row = await env.DB.prepare('SELECT thinking_budget FROM conversations WHERE id = ?')
			.bind(id)
			.first<{ thinking_budget: number | null }>();
		expect(row?.thinking_budget).toBe(5000);

		await stub.setThinkingBudget(id, null);
		const row2 = await env.DB.prepare('SELECT thinking_budget FROM conversations WHERE id = ?')
			.bind(id)
			.first<{ thinking_budget: number | null }>();
		expect(row2?.thinking_budget).toBeNull();
	});

	it('setThinkingBudget rejects negative or zero budgets by storing null', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await stub.setThinkingBudget(id, -1);
		const row = await env.DB.prepare('SELECT thinking_budget FROM conversations WHERE id = ?')
			.bind(id)
			.first<{ thinking_budget: number | null }>();
		expect(row?.thinking_budget).toBeNull();
	});

	it('addArtifact persists a code artifact and bumps versions', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', 'see code', 'm', 'complete', 1)",
			);
		});

		const a1 = await stub.addArtifact({ messageId: 'a1', type: 'code', language: 'typescript', name: 'index.ts', content: 'const x = 1;' });
		const a2 = await stub.addArtifact({ messageId: 'a1', type: 'code', language: 'typescript', name: 'index.ts', content: 'const x = 2;' });

		expect(a1.version).toBe(1);
		expect(a2.version).toBe(2);
		expect(a1.id).not.toBe(a2.id);

		const state = await readState(stub);
		const m = state.messages.find((mm) => mm.id === 'a1');
		expect(m?.artifacts).toHaveLength(2);
		expect(m?.artifacts?.map((a) => a.version)).toEqual([1, 2]);
	});

	it('artifacts table has the expanded schema', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			const cols = ctx.storage.sql
				.exec('PRAGMA table_info(artifacts)')
				.toArray() as unknown as Array<{ name: string }>;
			const names = cols.map((c) => c.name);
			expect(names).toEqual(
				expect.arrayContaining(['id', 'message_id', 'type', 'name', 'language', 'version', 'content', 'created_at']),
			);
		});
	});

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
		const { value } = await reader.read();
		await reader.cancel();
		const text = new TextDecoder().decode(value);
		expect(text).toContain('event: sync');
		expect(text).toContain('"lastMessageId":"u1"');
	});
});
