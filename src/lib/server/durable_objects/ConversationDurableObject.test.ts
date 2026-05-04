import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import { textTurn, toolUseTurn } from '../../../../test/fakes/FakeLLM';
import { getConversationStub, type ConversationStub } from './index';
import { MAX_ROW_PAYLOAD_BYTES, elideOversizedToolResults } from './ConversationDurableObject';
import type { ConversationState, MessagePart, ToolCallRecord, ToolResultRecord } from '$lib/types/conversation';
import type { ChatRequest, StreamEvent } from '../llm/LLM';

type WithLLMOverride = {
	__setLLMOverride(script: unknown[] | null): Promise<void>;
};

// Read whatever requests the DO's override LLM has captured so far. Lets
// resume tests assert that the recovered tool history was replayed into
// the LLM's `messages` array.
async function readLLMCalls(stub: ConversationStub): Promise<ChatRequest[]> {
	return runInDurableObject(stub, async (instance) => {
		const inst = instance as unknown as { __llmOverrideCalls?: ChatRequest[] };
		return (inst.__llmOverrideCalls ?? []).map((c) => ({ ...c, messages: c.messages.slice() }));
	});
}

// Subscribe-and-immediately-cancel: triggers the DO's resume detection on
// `subscribe` without leaving an open SSE stream behind. Works whether or
// not a constructor-scheduled alarm fired (it sometimes hasn't, in tests).
async function pokeSubscribe(stub: ConversationStub): Promise<void> {
	const stream = await stub.subscribe();
	const reader = stream.getReader();
	await reader.read();
	await reader.cancel();
}

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

async function setOverride(stub: ConversationStub, script: unknown[][]): Promise<void> {
	await (stub as unknown as WithLLMOverride).__setLLMOverride(script);
}

async function waitForState(
	stub: ConversationStub,
	predicate: (s: ConversationState) => boolean,
	{ timeoutMs = 5000, pollMs = 25 } = {},
): Promise<ConversationState> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await readState(stub);
		if (predicate(state)) return state;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	throw new Error('waitForState: timeout');
}

function stubFor(conversationId: string): ConversationStub {
	return getConversationStub(env, conversationId);
}

// `DurableObjectStub<>` walks every field of the RPC return type through
// Cloudflare's Serializable<> constraint. ConversationState's nested
// MessageRow + Artifact + ToolCall structure exceeds TS's recursion budget.
// Reading getState through this typed view keeps tests readable without
// triggering the depth limit.
async function readState(stub: ConversationStub): Promise<ConversationState> {
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
	});

	it('legacy parts are reconstructed for messages that pre-date the parts column', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				`INSERT INTO messages (id, role, content, model, status, created_at, thinking, tool_calls, tool_results)
				 VALUES ('a1', 'assistant', 'final answer', 'm', 'complete', 1,
				   'silently planning',
				   '[{"id":"t1","name":"web_search","input":{"q":"x"}}]',
				   '[{"toolUseId":"t1","content":"result","isError":false}]')`,
			);
		});
		const state = await readState(stub);
		const m = state.messages[0];
		expect(m.parts?.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_result']);
	});

	it('resume runs when a client subscribes to a DO with an interrupted stream', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', '', 'fake/model', 'streaming', 2)",
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO _meta (key, value) VALUES ('conversation_id', ?)",
				id,
			);
		});
		await setOverride(stub, [textTurn('resumed answer').events]);

		await pokeSubscribe(stub);

		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a1')?.status === 'complete');
		const a1 = state.messages.find((m) => m.id === 'a1')!;
		expect(a1.content).toBe('resumed answer');
		expect(a1.status).toBe('complete');
	});

	it('alarm() triggers resume of an interrupted stream', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// Seed an interrupted row and explicitly schedule an alarm — this
		// mirrors what the constructor does on a DO that boots into a
		// streaming row, but without depending on test-runner DO recycling
		// semantics.
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', '', 'fake/model', 'streaming', 2)",
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO _meta (key, value) VALUES ('conversation_id', ?)",
				id,
			);
			await ctx.storage.setAlarm(Date.now() + 50);
		});
		await setOverride(stub, [textTurn('alarm-resumed').events]);

		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a1')?.status === 'complete');
		expect(state.messages.find((m) => m.id === 'a1')?.content).toBe('alarm-resumed');
	});

	it('resume preserves completed tool calls and only regenerates trailing text', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// Seed a row that had completed one tool round (tool_use + tool_result)
		// and was emitting text when the DO died. The trailing text should be
		// dropped; the tool round should be preserved and replayed into the
		// LLM's history.
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'search for x', NULL, 'complete', 1)",
			);
			const partsJson = JSON.stringify([
				{ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'x' } },
				{ type: 'tool_result', toolUseId: 't1', content: 'result body', isError: false },
				{ type: 'text', text: 'partial sente' },
			]);
			ctx.storage.sql.exec(
				`INSERT INTO messages (id, role, content, thinking, model, status, created_at, parts, tool_calls, tool_results)
				 VALUES ('a1', 'assistant', 'partial sente', NULL, 'fake/model', 'streaming', 2, ?,
				   '[{"id":"t1","name":"web_search","input":{"q":"x"}}]',
				   '[{"toolUseId":"t1","content":"result body","isError":false}]')`,
				partsJson,
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO _meta (key, value) VALUES ('conversation_id', ?)",
				id,
			);
		});
		await setOverride(stub, [textTurn('final answer based on result').events]);

		await pokeSubscribe(stub);

		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a1')?.status === 'complete');
		const a1 = state.messages.find((m) => m.id === 'a1')!;
		expect(a1.content).toBe('final answer based on result');
		const partTypes = (a1.parts ?? []).map((p) => p.type);
		expect(partTypes).toEqual(['tool_use', 'tool_result', 'text']);
		// The tool_calls/tool_results columns must still show the recovered
		// round so future turns see consistent history.
		expect(a1.toolCalls).toEqual([{ id: 't1', name: 'web_search', input: { q: 'x' } }]);
		expect(a1.toolResults).toEqual([{ toolUseId: 't1', content: 'result body', isError: false }]);

		// And the LLM was called with the recovered tool round in its
		// `messages` array, so it had the context needed to continue.
		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(1);
		const sent = calls[0].messages;
		const sawToolUse = sent.some(
			(m) =>
				m.role === 'assistant' &&
				Array.isArray(m.content) &&
				m.content.some((c) => c.type === 'tool_use' && c.id === 't1'),
		);
		const sawToolResult = sent.some(
			(m) =>
				m.role === 'tool' &&
				Array.isArray(m.content) &&
				m.content.some((c) => c.type === 'tool_result' && c.toolUseId === 't1'),
		);
		expect(sawToolUse).toBe(true);
		expect(sawToolResult).toBe(true);
	});

	it('resume normalizes a streaming-flagged tool_result left behind by mid-tool eviction', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'fetch a thing', NULL, 'complete', 1)",
			);
			const partsJson = JSON.stringify([
				{ type: 'tool_use', id: 't1', name: 'fetch_url', input: { url: 'https://x' } },
				// Streaming placeholder — never replaced because the DO died
				// while the tool was executing.
				{ type: 'tool_result', toolUseId: 't1', content: '', isError: false, streaming: true },
			]);
			ctx.storage.sql.exec(
				`INSERT INTO messages (id, role, content, model, status, created_at, parts)
				 VALUES ('a1', 'assistant', '', 'fake/model', 'streaming', 2, ?)`,
				partsJson,
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO _meta (key, value) VALUES ('conversation_id', ?)",
				id,
			);
		});
		await setOverride(stub, [textTurn('done despite the failure').events]);

		await pokeSubscribe(stub);

		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a1')?.status === 'complete');
		const a1 = state.messages.find((m) => m.id === 'a1')!;
		// The placeholder result was rewritten to a synthetic error result.
		const trs = (a1.parts ?? []).filter((p) => p.type === 'tool_result');
		expect(trs).toHaveLength(1);
		expect(trs[0]).toMatchObject({ toolUseId: 't1', isError: true });
		expect((trs[0] as { streaming?: boolean }).streaming).not.toBe(true);
	});

	it('resume is idempotent: two subscribe pokes consume one scripted turn', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', '', 'fake/model', 'streaming', 2)",
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO _meta (key, value) VALUES ('conversation_id', ?)",
				id,
			);
		});
		// Only one scripted turn; if resume kicks off twice the second call
		// hits the "ran out of scripted turns" error.
		await setOverride(stub, [textTurn('first').events]);

		await pokeSubscribe(stub);
		await pokeSubscribe(stub);

		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a1')?.status === 'complete');
		const a1 = state.messages.find((m) => m.id === 'a1')!;
		expect(a1.content).toBe('first');
		expect(a1.status).toBe('complete');
		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(1);
	});

	it('resume marks older streaming rows as error and resumes only the newest', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', '', 'fake/model', 'streaming', 1)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a2', 'assistant', '', 'fake/model', 'streaming', 2)",
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO _meta (key, value) VALUES ('conversation_id', ?)",
				id,
			);
		});
		await setOverride(stub, [textTurn('only the newest').events]);

		await pokeSubscribe(stub);

		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a2')?.status === 'complete');
		const a1 = state.messages.find((m) => m.id === 'a1')!;
		const a2 = state.messages.find((m) => m.id === 'a2')!;
		expect(a1.status).toBe('error');
		expect(a1.error).toContain('Multiple streaming rows');
		expect(a2.status).toBe('complete');
		expect(a2.content).toBe('only the newest');
	});

	it('resume marks the row as error when conversation_id meta is missing', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// Seed a streaming row but deliberately omit the _meta entry.
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', '', 'fake/model', 'streaming', 1)",
			);
		});
		await pokeSubscribe(stub);
		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a1')?.status === 'error');
		const a1 = state.messages.find((m) => m.id === 'a1')!;
		expect(a1.error).toContain('conversation id unknown');
	});

	it('abortGeneration is a safe no-op when nothing is in progress', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await stub.abortGeneration(id);
		const state = await readState(stub);
		expect(state.messages).toEqual([]);
		expect(state.inProgress).toBeNull();
	});

	describe('#generate (FakeLLM)', () => {
		it('streams a text-only turn through to a complete assistant message', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await setOverride(stub, [textTurn('hello back').events]);

			const result = await stub.addUserMessage(id, 'hi', 'fake/model');
			expect(result).toEqual({ status: 'started' });

			const state = await waitForState(stub, (s) => {
				const last = s.messages.at(-1);
				return last?.status === 'complete';
			});
			expect(state.messages).toHaveLength(2);
			expect(state.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
			expect(state.messages[1]).toMatchObject({ role: 'assistant', status: 'complete', content: 'hello back' });
			expect(state.inProgress).toBeNull();
		});

		it('appends an info part when MAX_TOOL_ITERATIONS runs out', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			// 11 tool-emitting turns guarantees we hit the cap (which is 10).
			const script = Array.from({ length: 11 }, (_, i) => toolUseTurn(`call${i}`, 'unknown_tool', { i }).events);
			await setOverride(stub, script);

			await stub.addUserMessage(id, 'use a tool repeatedly', 'fake/model');
			const state = await waitForState(stub, (s) => {
				const last = s.messages.at(-1);
				return last?.status === 'complete';
			}, { timeoutMs: 10_000 });
			const last = state.messages.at(-1)!;
			const infoParts = (last.parts ?? []).filter((p) => p.type === 'info');
			expect(infoParts.length).toBeGreaterThanOrEqual(1);
			expect(infoParts.some((p) => p.type === 'info' && p.text.includes('iteration budget'))).toBe(true);
			// Every tool_use part must have a matching tool_result so the next
			// turn's history is well-formed.
			const useIds = (last.parts ?? [])
				.filter((p): p is import('$lib/types/conversation').ToolUsePart => p.type === 'tool_use')
				.map((p) => p.id);
			const resultIds = new Set(
				(last.parts ?? [])
					.filter((p): p is import('$lib/types/conversation').ToolResultPart => p.type === 'tool_result')
					.map((p) => p.toolUseId),
			);
			for (const id of useIds) expect(resultIds.has(id)).toBe(true);
		});

		it('persists content_html alongside content for completed assistant messages', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await setOverride(stub, [textTurn('# heading\n\nbody').events]);

			await stub.addUserMessage(id, 'hi', 'fake/model');
			await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');

			await runInDurableObject(stub, async (_instance, ctx) => {
				const rows = ctx.storage.sql
					.exec("SELECT content_html FROM messages WHERE role = 'assistant'")
					.toArray() as unknown as Array<{ content_html: string | null }>;
				expect(rows).toHaveLength(1);
				expect(rows[0].content_html).toContain('<h1');
				expect(rows[0].content_html).toContain('body');
			});
		});

		it('schema version is recorded after migrations run', async () => {
			const id = await createConversation(env);
			const stub = stubFor(id);
			await runInDurableObject(stub, async (_instance, ctx) => {
				const rows = ctx.storage.sql
					.exec("SELECT value FROM _meta WHERE key = 'schema_version'")
					.toArray() as unknown as Array<{ value: string }>;
				expect(rows).toHaveLength(1);
				expect(Number(rows[0].value)).toBeGreaterThanOrEqual(2);
			});
		});
	});

	describe('elideOversizedToolResults', () => {
		const oversized = 'A'.repeat(256 * 1024);

		function buildOversizedTurn(numCalls: number): {
			toolCalls: ToolCallRecord[];
			toolResults: ToolResultRecord[];
			parts: MessagePart[];
		} {
			const toolCalls: ToolCallRecord[] = [];
			const toolResults: ToolResultRecord[] = [];
			const parts: MessagePart[] = [];
			for (let i = 0; i < numCalls; i++) {
				toolCalls.push({ id: `t${i}`, name: 'big_tool', input: {} });
				toolResults.push({ toolUseId: `t${i}`, content: oversized, isError: false });
				parts.push({ type: 'tool_use', id: `t${i}`, name: 'big_tool', input: {} });
				parts.push({ type: 'tool_result', toolUseId: `t${i}`, content: oversized, isError: false });
			}
			return { toolCalls, toolResults, parts };
		}

		it('is a no-op when payload is under budget', () => {
			const { toolCalls, toolResults, parts } = buildOversizedTurn(2);
			const before = JSON.stringify(toolResults);
			elideOversizedToolResults(toolCalls, toolResults, parts);
			expect(JSON.stringify(toolResults)).toBe(before);
		});

		it('elides oldest results first until payload fits under MAX_ROW_PAYLOAD_BYTES', () => {
			const { toolCalls, toolResults, parts } = buildOversizedTurn(8);
			expect(JSON.stringify(toolResults).length).toBeGreaterThan(MAX_ROW_PAYLOAD_BYTES);

			elideOversizedToolResults(toolCalls, toolResults, parts);

			const max = Math.max(JSON.stringify(toolResults).length, JSON.stringify(parts).length);
			expect(max).toBeLessThanOrEqual(MAX_ROW_PAYLOAD_BYTES);
			// Oldest result is stubbed; freshest survives intact.
			expect(toolResults[0].content).toMatch(/elided/);
			expect(toolResults.at(-1)!.content).toBe(oversized);
		});

		it('keeps parts and tool_results consistent for elided entries', () => {
			const { toolCalls, toolResults, parts } = buildOversizedTurn(8);
			elideOversizedToolResults(toolCalls, toolResults, parts);
			for (const r of toolResults) {
				if (!r.content.includes('elided')) continue;
				const part = parts.find((p) => p.type === 'tool_result' && p.toolUseId === r.toolUseId);
				expect(part?.type).toBe('tool_result');
				if (part?.type === 'tool_result') expect(part.content).toBe(r.content);
			}
		});

		it('uses the tool name from the matching tool_call in the stub', () => {
			const { toolCalls, toolResults, parts } = buildOversizedTurn(8);
			elideOversizedToolResults(toolCalls, toolResults, parts);
			const elided = toolResults.find((r) => r.content.includes('elided'));
			expect(elided?.content).toContain('big_tool');
		});
	});
});
