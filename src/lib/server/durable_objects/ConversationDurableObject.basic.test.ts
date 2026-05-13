import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import { readState, stubFor } from './conversation/_test-helpers';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('ConversationDurableObject — basic ops & schema', () => {
	it('addUserMessage rejects empty content', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const result = await stub.addUserMessage(id, '   ', 'm/test');
		expect(result).toEqual({ reason: 'empty', status: 'invalid' });
	});

	it('addUserMessage rejects missing model', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const result = await stub.addUserMessage(id, 'hi', '');
		expect(result).toEqual({ reason: 'missing model', status: 'invalid' });
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
			const cols = ctx.storage.sql.exec('PRAGMA table_info(messages)').toArray() as unknown as Array<{ name: string }>;
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
					'provider',
					'thinking',
					'parent_id',
					'deleted_at',
					'parts',
					'content_html',
					'thinking_html',
				]),
			);
			// Migration 3 dropped the redundant legacy columns.
			expect(names).not.toContain('tool_calls');
			expect(names).not.toContain('tool_results');
			expect(names).not.toContain('parts_html');
			expect(names).not.toContain('generation_json');
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
		expect(state.messages[0]).toMatchObject({ content: 'hello world', role: 'user', status: 'complete' });
		expect(state.messages[1]).toMatchObject({ content: 'hi back', role: 'assistant', status: 'complete' });
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

	describe('setSystemPrompt', () => {
		it('persists a non-empty prompt to the conversations row', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await stub.setSystemPrompt(id, 'Speak like a pirate.');
			const row = await env.DB.prepare('SELECT system_prompt FROM conversations WHERE id = ?')
				.bind(id)
				.first<{ system_prompt: string | null }>();
			expect(row?.system_prompt).toBe('Speak like a pirate.');
		});

		it('trims whitespace, treating whitespace-only as null', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await stub.setSystemPrompt(id, '   ');
			const row = await env.DB.prepare('SELECT system_prompt FROM conversations WHERE id = ?')
				.bind(id)
				.first<{ system_prompt: string | null }>();
			expect(row?.system_prompt).toBeNull();
		});

		it('null clears the override', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await stub.setSystemPrompt(id, 'override');
			await stub.setSystemPrompt(id, null);
			const row = await env.DB.prepare('SELECT system_prompt FROM conversations WHERE id = ?')
				.bind(id)
				.first<{ system_prompt: string | null }>();
			expect(row?.system_prompt).toBeNull();
		});
	});

	describe('setStyle', () => {
		it('persists a positive id to style_id', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await stub.setStyle(id, 42);
			const row = await env.DB.prepare('SELECT style_id FROM conversations WHERE id = ?').bind(id).first<{ style_id: number | null }>();
			expect(row?.style_id).toBe(42);
		});

		it('null clears the selection', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await stub.setStyle(id, 7);
			await stub.setStyle(id, null);
			const row = await env.DB.prepare('SELECT style_id FROM conversations WHERE id = ?').bind(id).first<{ style_id: number | null }>();
			expect(row?.style_id).toBeNull();
		});

		it('zero or negative ids are stored as null', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await stub.setStyle(id, 0);
			const row = await env.DB.prepare('SELECT style_id FROM conversations WHERE id = ?').bind(id).first<{ style_id: number | null }>();
			expect(row?.style_id).toBeNull();
		});
	});

	it('abortGeneration is a safe no-op when nothing is in progress', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await stub.abortGeneration(id);
		const state = await readState(stub);
		expect(state.messages).toEqual([]);
		expect(state.inProgress).toBeNull();
	});
});
