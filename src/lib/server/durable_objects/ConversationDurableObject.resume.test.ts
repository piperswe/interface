import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import { textTurn } from '../../../../test/fakes/FakeLLM';
import { pokeSubscribe, readLLMCalls, setOverride, stubFor, waitForState } from './conversation/_test-helpers';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('ConversationDurableObject — resume', () => {
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
		//
		// Regression: the alarm time must be far enough in the future that
		// workerd's natural alarm scheduler doesn't fire it on its own
		// before `runDurableObjectAlarm` runs. A short delay (e.g. +50ms)
		// races with the RPCs below: if the natural scheduler wins,
		// `runDurableObjectAlarm` finds no scheduled alarm and returns
		// `false`, or — worse — the alarm fires before `setOverride` has
		// landed and `#routeLLM` falls through to the real provider with an
		// unknown 'fake/model'. A minute is plenty: tests never run that
		// long, so the only path to alarm() is the explicit trigger below.
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
			await ctx.storage.setAlarm(Date.now() + 60_000);
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
				`INSERT INTO messages (id, role, content, thinking, model, status, created_at, parts)
				 VALUES ('a1', 'assistant', 'partial sente', NULL, 'fake/model', 'streaming', 2, ?)`,
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
		// The recovered tool round survives in `parts` so future turns see
		// consistent history.
		const tu = (a1.parts ?? []).find((p) => p.type === 'tool_use');
		expect(tu).toEqual({ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'x' } });
		const tr = (a1.parts ?? []).find((p) => p.type === 'tool_result');
		expect(tr).toEqual({ type: 'tool_result', toolUseId: 't1', content: 'result body', isError: false });

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

	it('resume falls back to default_model when the streaming row has no model recorded', async () => {
		// Regression: a streaming row whose `model` column was null (or that
		// references a model the operator has since deleted from /settings)
		// used to brick the conversation with "Cannot resume generation:
		// model unknown". Now we fall back to the user's default_model and
		// surface the swap as an info part.
		const { createProvider } = await import('../providers/store');
		const { createModel } = await import('../providers/models');
		const { setSetting } = await import('../settings');
		await createProvider(env, {
			id: 'fallback-provider',
			type: 'openai_compatible',
			apiKey: 'sk-test',
			endpoint: 'https://api.example.com/v1',
		});
		await createModel(env, 'fallback-provider', { id: 'fallback-model', name: 'Fallback' });
		await setSetting(env, 'default_model', 'fallback-provider/fallback-model');

		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
			// Stored model column NULL — old row, or a row whose model was
			// deleted from settings. The override-skip in #resolveResumeModel
			// only short-circuits for non-null stored values, so this null
			// path exercises the real fallback resolution.
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', '', NULL, 'streaming', 2)",
			);
			ctx.storage.sql.exec(
				"INSERT OR REPLACE INTO _meta (key, value) VALUES ('conversation_id', ?)",
				id,
			);
		});
		// Override the LLM so the fallback model's resume call doesn't try to
		// hit the real network.
		await setOverride(stub, [textTurn('answered with fallback').events]);

		await pokeSubscribe(stub);

		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a1')?.status === 'complete');
		const a1 = state.messages.find((m) => m.id === 'a1')!;
		expect(a1.status).toBe('complete');
		// The row's model column was rewritten to the fallback.
		expect(a1.model).toBe('fallback-provider/fallback-model');
		// And a visible info part records the swap.
		const infoParts = (a1.parts ?? []).filter((p) => p.type === 'info') as Array<{ type: 'info'; text: string }>;
		expect(infoParts.some((p) => p.text.includes('fallback-provider/fallback-model'))).toBe(true);

		await env.DB.prepare('DELETE FROM provider_models').run();
		await env.DB.prepare('DELETE FROM providers').run();
		await env.DB.prepare("DELETE FROM settings WHERE key = 'default_model'").run();
	});
});
