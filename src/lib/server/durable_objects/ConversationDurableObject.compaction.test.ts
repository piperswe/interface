// Integration tests for context compaction. Two paths exercised:
//
//   1. `compactContext()` RPC — the "compact now" button. Forces a 50%
//      ceiling, soft-deletes dropped rows, and inserts a visible info-part
//      summary as a new assistant row.
//   2. Auto-compaction in `#generate()` — runs before each LLM chat request
//      and respects the user-configured threshold. Persists the summary as
//      an info part on the in-progress assistant message and uses the
//      compacted message list for the LLM call.
//
// Both paths funnel through `compactHistory()` (covered by unit tests in
// `context.test.ts`); these tests validate the wiring around it: history
// reconstruction from D1 rows, soft-delete bookkeeping, broadcast events,
// LLM call shape, and threshold/cache-aware token accounting.

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InfoPart } from '$lib/types/conversation';
import { assertDefined } from '../../../../test/assert-defined';
import { textTurn } from '../../../../test/fakes/FakeLLM';
import { createConversation } from '../conversations';
import type { ChatRequest, StreamEvent } from '../llm/LLM';
import * as routeMod from '../llm/route';
import { createModel } from '../providers/models';
import { createProvider } from '../providers/store';
import { setSetting } from '../settings';
import { readLLMCalls, readState, setOverride, stubFor, waitForState } from './conversation/_test-helpers';
import type { ConversationStub } from './index';

// Used by ad-hoc seed helpers that need access to the underlying SqlStorage.
type SeedRow = {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	model?: string | null;
	parts?: string | null;
	usage_json?: string | null;
	createdAt: number;
	deletedAt?: number | null;
};

afterEach(async () => {
	vi.restoreAllMocks();
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM conversations').run();
	await env.DB.prepare('DELETE FROM memories').run();
});

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
	await env.DB.prepare('DELETE FROM settings').run();
});

async function registerFakeModel(maxContextLength: number): Promise<void> {
	await createProvider(env, { apiKey: 'k', id: 'fake', type: 'openai_compatible' });
	await createModel(env, 'fake', { id: 'model', maxContextLength, name: 'Fake' });
}

// `compactContext()` calls `compactHistory(... {}, true)` with empty deps,
// so the summarization LLM is resolved through the real `routeLLMByGlobalId`
// — NOT the per-DO override script. To deterministically test the success
// path we mock the module export. vitest-pool-workers shares one isolate, so
// the spy propagates into the DO's imports.
function mockSummaryRoute(text: string): void {
	async function* gen(): AsyncGenerator<StreamEvent> {
		yield { delta: text, type: 'text_delta' };
		yield { type: 'done' };
	}
	vi.spyOn(routeMod, 'routeLLMByGlobalId').mockResolvedValue({
		chat: () => gen(),
		model: 'fake/model',
		providerID: 'mock',
	} as never);
}

async function seedMessages(stub: ConversationStub, rows: SeedRow[]): Promise<void> {
	await runInDurableObject(stub, async (_instance, ctx) => {
		for (const row of rows) {
			ctx.storage.sql.exec(
				'INSERT INTO messages (id, role, content, model, status, parts, usage_json, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
				row.id,
				row.role,
				row.content,
				row.model ?? null,
				'complete',
				row.parts ?? null,
				row.usage_json ?? null,
				row.createdAt,
				row.deletedAt ?? null,
			);
		}
	});
}

// Build a multi-turn seed of 6 messages (3 user/assistant pairs) where each
// pair contains a chunk of filler so total tokens are predictable. The last
// pair is small ("recent q" / "recent a") so we can assert preservation.
function bigPairs(filler: string, recentQ = 'recent q', recentA = 'recent a'): SeedRow[] {
	return [
		{ content: `q0 ${filler}`, createdAt: 100, id: 'u0', role: 'user' },
		{ content: `a0 ${filler}`, createdAt: 101, id: 'a0', model: 'fake/model', role: 'assistant' },
		{ content: `q1 ${filler}`, createdAt: 102, id: 'u1', role: 'user' },
		{ content: `a1 ${filler}`, createdAt: 103, id: 'a1', model: 'fake/model', role: 'assistant' },
		{ content: recentQ, createdAt: 104, id: 'u2', role: 'user' },
		{ content: recentA, createdAt: 105, id: 'a2', model: 'fake/model', role: 'assistant' },
	];
}

// ---------------------------------------------------------------------------
// compactContext() — RPC path
// ---------------------------------------------------------------------------

describe('ConversationDurableObject.compactContext — preconditions', () => {
	it('returns { compacted: false } when there are no completed assistant messages', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// No model can be inferred without a prior assistant row → bail out.
		const result = await stub.compactContext(id);
		expect(result).toEqual({ compacted: false, droppedCount: 0 });
	});

	it('returns { compacted: false } when only a single user/assistant pair exists', async () => {
		// minKeep=4 inside compactHistory means a 2-message conversation can
		// never compact, even when forced.
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		await seedMessages(stub, [
			{ content: 'hi', createdAt: 100, id: 'u0', role: 'user' },
			{ content: 'hello', createdAt: 101, id: 'a0', model: 'fake/model', role: 'assistant' },
		]);
		const result = await stub.compactContext(id);
		expect(result).toEqual({ compacted: false, droppedCount: 0 });
	});

	it('returns { compacted: false } when the last assistant row has no model', async () => {
		// Without a model, the DO can't route a summarization LLM, so it
		// short-circuits before calling compactHistory.
		const id = await createConversation(env);
		const stub = stubFor(id);
		await seedMessages(stub, [
			{ content: 'hi', createdAt: 100, id: 'u0', role: 'user' },
			{ content: 'hello', createdAt: 101, id: 'a0', model: null, role: 'assistant' },
		]);
		const result = await stub.compactContext(id);
		expect(result).toEqual({ compacted: false, droppedCount: 0 });
	});
});

describe('ConversationDurableObject.compactContext — compaction succeeds', () => {
	it('soft-deletes dropped rows and inserts a new assistant row with an info-part summary', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		await setSetting(env, 'context_compaction_threshold', '0'); // force=true ignores this
		// compactContext skips the DO's override script (it calls
		// compactHistory with empty deps), so we mock the real route.
		mockSummaryRoute('SUMMARY-OF-EARLIER-TURNS');

		const filler = 'lorem ipsum dolor sit amet '.repeat(80); // ~590 tokens
		await seedMessages(stub, bigPairs(filler));

		const result = await stub.compactContext(id);
		expect(result.compacted).toBe(true);
		expect(result.droppedCount).toBeGreaterThan(0);

		// The new assistant row's parts should contain an info part with the
		// "Context compacted: ..." prefix and the summary text.
		const state = await readState(stub);
		const summaryRow = state.messages.find((m) => m.parts?.some((p) => p.type === 'info' && p.text.startsWith('Context compacted:')));
		expect(summaryRow).toBeTruthy();
		assertDefined(summaryRow);
		expect(summaryRow.role).toBe('assistant');
		assertDefined(summaryRow.parts);
		const infoPart = summaryRow.parts.find((p): p is InfoPart => p.type === 'info');
		assertDefined(infoPart);
		expect(infoPart.text).toContain(`summarized ${result.droppedCount} earlier messages`);
		expect(infoPart.text).toContain('SUMMARY-OF-EARLIER-TURNS');
	});

	it('preserves the most-recent two exchanges with their original IDs and content intact', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		mockSummaryRoute('SUMMARY');

		const filler = 'lorem ipsum dolor sit amet '.repeat(80);
		await seedMessages(stub, bigPairs(filler, 'KEEP-Q', 'KEEP-A'));

		await stub.compactContext(id);

		// Look directly at the raw DB rows (excluding soft-deleted) so we can
		// assert ID + content stability for the kept messages.
		await runInDurableObject(stub, async (_instance, ctx) => {
			const surviving = ctx.storage.sql
				.exec('SELECT id, content FROM messages WHERE deleted_at IS NULL ORDER BY created_at ASC')
				.toArray() as unknown as Array<{ id: string; content: string }>;
			// u2/a2 must be present unchanged. The new summary row is also
			// present (newer created_at).
			const ids = surviving.map((r) => r.id);
			expect(ids).toContain('u2');
			expect(ids).toContain('a2');
			const u2 = surviving.find((r) => r.id === 'u2');
			assertDefined(u2);
			expect(u2.content).toBe('KEEP-Q');
			const a2 = surviving.find((r) => r.id === 'a2');
			assertDefined(a2);
			expect(a2.content).toBe('KEEP-A');
		});
	});

	it('broadcasts a refresh event so subscribers re-render after compaction', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		mockSummaryRoute('SUMMARY');
		const filler = 'lorem ipsum dolor sit amet '.repeat(80);
		await seedMessages(stub, bigPairs(filler));

		const stream = await stub.subscribe();
		const reader = stream.getReader();
		const decoder = new TextDecoder();

		await stub.compactContext(id);

		// Drain frames until a refresh frame appears (or we time out). The
		// initial transmission is split across multiple writes (a `retry:`
		// preamble, an initial `sync` frame, then the post-compaction
		// `refresh`), so we accumulate and search.
		let buffer = '';
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && !buffer.includes('event: refresh')) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) buffer += decoder.decode(value, { stream: true });
		}
		await reader.cancel();
		expect(buffer).toContain('event: refresh');
	});

	it('a second compaction does not re-consider messages soft-deleted by the first', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		mockSummaryRoute('SUMMARY');

		const filler = 'lorem ipsum dolor sit amet '.repeat(80);
		await seedMessages(stub, bigPairs(filler));

		const first = await stub.compactContext(id);
		expect(first.compacted).toBe(true);
		const firstDropped = first.droppedCount;

		// Snapshot the soft-deleted ids before we add more material.
		const deletedIdsAfterFirst = await runInDurableObject(stub, async (_instance, ctx) => {
			return (
				ctx.storage.sql.exec('SELECT id FROM messages WHERE deleted_at IS NOT NULL ORDER BY id').toArray() as unknown as Array<{ id: string }>
			).map((r) => r.id);
		});
		expect(deletedIdsAfterFirst.length).toBe(firstDropped);

		// Add a fresh batch of large pairs so a second compaction has work
		// to do. Created_at strictly after the existing rows.
		await seedMessages(stub, [
			{ content: `q3 ${filler}`, createdAt: 200, id: 'u3', role: 'user' },
			{ content: `a3 ${filler}`, createdAt: 201, id: 'a3', model: 'fake/model', role: 'assistant' },
			{ content: `q4 ${filler}`, createdAt: 202, id: 'u4', role: 'user' },
			{ content: `a4 ${filler}`, createdAt: 203, id: 'a4', model: 'fake/model', role: 'assistant' },
			{ content: 'recent q', createdAt: 204, id: 'u5', role: 'user' },
			{ content: 'recent a', createdAt: 205, id: 'a5', model: 'fake/model', role: 'assistant' },
		]);

		const second = await stub.compactContext(id);
		expect(second.compacted).toBe(true);

		// The set of soft-deleted ids must strictly grow — none of the
		// originally-deleted ids may have been "un-deleted" or counted again.
		const deletedIdsAfterSecond = await runInDurableObject(stub, async (_instance, ctx) => {
			return (
				ctx.storage.sql.exec('SELECT id FROM messages WHERE deleted_at IS NOT NULL ORDER BY id').toArray() as unknown as Array<{ id: string }>
			).map((r) => r.id);
		});
		for (const id of deletedIdsAfterFirst) {
			expect(deletedIdsAfterSecond).toContain(id);
		}
		expect(deletedIdsAfterSecond.length).toBeGreaterThan(deletedIdsAfterFirst.length);
		// And the second compaction's droppedCount should match how many new
		// rows it transitioned to soft-deleted, not the cumulative total.
		expect(second.droppedCount).toBe(deletedIdsAfterSecond.length - deletedIdsAfterFirst.length);
	});

	it('returns { compacted: false } when the most-recent messages already fit a 50% budget', async () => {
		// Force=true uses 50% of 128k. Six small messages can't exceed 64k →
		// the dropIndex search returns 0, the slice is empty, and the helper
		// returns wasCompacted=true with summary=''. The DO surface coerces
		// the empty-summary case to { compacted: false }.
		const id = await createConversation(env);
		const stub = stubFor(id);
		// Don't register the model — fall back to the 128k default.
		await seedMessages(stub, [
			{ content: 'q0', createdAt: 100, id: 'u0', role: 'user' },
			{ content: 'a0', createdAt: 101, id: 'a0', model: 'fake/model', role: 'assistant' },
			{ content: 'q1', createdAt: 102, id: 'u1', role: 'user' },
			{ content: 'a1', createdAt: 103, id: 'a1', model: 'fake/model', role: 'assistant' },
			{ content: 'q2', createdAt: 104, id: 'u2', role: 'user' },
			{ content: 'a2', createdAt: 105, id: 'a2', model: 'fake/model', role: 'assistant' },
		]);
		const result = await stub.compactContext(id);
		expect(result).toEqual({ compacted: false, droppedCount: 0 });
		// And no info-part summary was inserted.
		const state = await readState(stub);
		const hasSummary = state.messages.some((m) => m.parts?.some((p) => p.type === 'info' && p.text.startsWith('Context compacted:')));
		expect(hasSummary).toBe(false);
	});

	it('falls back to a raw-text summary if the summarization LLM errors', async () => {
		// Override script emits an `error` event on the first turn — context.ts
		// catches and falls back to slicing the dropped transcript.
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		await setOverride(stub, [[{ message: 'boom', type: 'error' } as StreamEvent]]);
		const filler = 'lorem ipsum dolor sit amet '.repeat(80);
		await seedMessages(stub, bigPairs(filler));

		const result = await stub.compactContext(id);
		expect(result.compacted).toBe(true);
		const state = await readState(stub);
		const summaryRow = state.messages.find((m) => m.parts?.some((p) => p.type === 'info' && p.text.startsWith('Context compacted:')));
		expect(summaryRow).toBeTruthy();
		assertDefined(summaryRow);
		assertDefined(summaryRow.parts);
		const infoPart = summaryRow.parts.find((p): p is InfoPart => p.type === 'info');
		assertDefined(infoPart);
		// Raw fallback echoes the dropped transcript.
		expect(infoPart.text).toMatch(/lorem ipsum/);
	});
});

// ---------------------------------------------------------------------------
// Auto-compaction inside #generate()
// ---------------------------------------------------------------------------

describe('ConversationDurableObject.#generate — auto-compaction', () => {
	it('compacts before sending and feeds the summary to the next LLM call', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		await setSetting(env, 'context_compaction_threshold', '50');

		// Seed completed history that overflows 50% of 2000. The most recent
		// assistant row's usage_json will be read for the cache-aware estimate.
		const filler = 'lorem ipsum dolor sit amet '.repeat(80);
		await seedMessages(stub, [
			{ content: `q0 ${filler}`, createdAt: 100, id: 'u0', role: 'user' },
			{ content: `a0 ${filler}`, createdAt: 101, id: 'a0', model: 'fake/model', role: 'assistant' },
			{ content: `q1 ${filler}`, createdAt: 102, id: 'u1', role: 'user' },
			{ content: `a1 ${filler}`, createdAt: 103, id: 'a1', model: 'fake/model', role: 'assistant' },
			{
				content: 'kept q',
				createdAt: 104,
				id: 'u2',
				role: 'user',
			},
			{
				content: 'kept a',
				createdAt: 105,
				id: 'a2',
				model: 'fake/model',
				role: 'assistant',
				usage_json: JSON.stringify({ inputTokens: 1500 }), // > 50% of 2000
			},
		]);

		// Two turns: turn-1 = summarization output, turn-2 = real reply.
		await setOverride(stub, [textTurn('SUMMARY-OUT').events, textTurn('final reply').events]);

		await stub.addUserMessage(id, 'next question', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', { timeoutMs: 5000 });

		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(2);

		// The first call is the summarization request — system + user only,
		// no tools, low temperature.
		const summaryCall = calls[0];
		expect(summaryCall.messages.map((m) => m.role)).toEqual(['system', 'user']);
		expect(summaryCall.temperature).toBeCloseTo(0.3, 5);

		// The second call is the actual generate — its messages list must
		// start with the system summary that compactHistory prepended.
		const generateCall = calls[1];
		expect(generateCall.messages[0].role).toBe('system');
		expect(generateCall.messages[0].content).toContain('Previous conversation summary:');
		expect(generateCall.messages[0].content).toContain('SUMMARY-OUT');
		// Recent kept messages must still be present.
		const flatContents = generateCall.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
		expect(flatContents.some((c) => c.includes('kept a'))).toBe(true);
		expect(flatContents.some((c) => c.includes('next question'))).toBe(true);

		// The assistant message gains an info part announcing compaction.
		const state = await readState(stub);
		const last = state.messages.at(-1);
		assertDefined(last);
		expect(last.role).toBe('assistant');
		expect(last.content).toBe('final reply');
		const infoPart = last.parts?.find((p): p is InfoPart => p.type === 'info');
		expect(infoPart).toBeTruthy();
		assertDefined(infoPart);
		expect(infoPart.text).toContain('Context compacted:');
		expect(infoPart.text).toMatch(/summarized \d+ earlier messages/);
	});

	it('threshold=0 disables auto-compaction even with a tiny context window', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(1000);
		await setSetting(env, 'context_compaction_threshold', '0');

		const filler = 'lorem ipsum dolor sit amet '.repeat(80);
		await seedMessages(stub, [
			{ content: `q0 ${filler}`, createdAt: 100, id: 'u0', role: 'user' },
			{ content: `a0 ${filler}`, createdAt: 101, id: 'a0', model: 'fake/model', role: 'assistant' },
			{ content: `q1 ${filler}`, createdAt: 102, id: 'u1', role: 'user' },
			{ content: `a1 ${filler}`, createdAt: 103, id: 'a1', model: 'fake/model', role: 'assistant' },
			{ content: `q2 ${filler}`, createdAt: 104, id: 'u2', role: 'user' },
			{ content: `a2 ${filler}`, createdAt: 105, id: 'a2', model: 'fake/model', role: 'assistant' },
		]);

		// Only a single turn — if compaction tries to run we'd see a second
		// LLM call and would run out of script (FakeLLM yields error on dry).
		await setOverride(stub, [textTurn('reply').events]);

		await stub.addUserMessage(id, 'one more', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', { timeoutMs: 5000 });

		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(1); // generate only, no summary call

		const state = await readState(stub);
		const last = state.messages.at(-1);
		assertDefined(last);
		const hasCompactInfo = last.parts?.some((p) => p.type === 'info' && p.text.startsWith('Context compacted:'));
		expect(hasCompactInfo).toBeFalsy();
	});

	it('cached tokens (cacheReadInputTokens) keep the budget under threshold', async () => {
		// Regression: a cache-heavy turn with a large reported inputTokens
		// must not trigger compaction. Effective tokens = inputTokens -
		// cacheReadInputTokens. Budget needs slack for the +1024 response margin.
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(4000);
		await setSetting(env, 'context_compaction_threshold', '50');

		await seedMessages(stub, [
			{ content: 'q0', createdAt: 100, id: 'u0', role: 'user' },
			{ content: 'a0', createdAt: 101, id: 'a0', model: 'fake/model', role: 'assistant' },
			{ content: 'q1', createdAt: 102, id: 'u1', role: 'user' },
			{ content: 'a1', createdAt: 103, id: 'a1', model: 'fake/model', role: 'assistant' },
			{ content: 'q2', createdAt: 104, id: 'u2', role: 'user' },
			{
				content: 'a2',
				createdAt: 105,
				id: 'a2',
				model: 'fake/model',
				role: 'assistant',
				usage_json: JSON.stringify({ cacheReadInputTokens: 4900, inputTokens: 5000 }),
			},
		]);

		// Only a single generate turn — if compaction kicks in the script runs out.
		await setOverride(stub, [textTurn('cached reply').events]);
		await stub.addUserMessage(id, 'go', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', { timeoutMs: 5000 });

		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(1);
		const state = await readState(stub);
		const last = state.messages.at(-1);
		assertDefined(last);
		expect(last.content).toBe('cached reply');
		const hasCompactInfo = last.parts?.some((p) => p.type === 'info' && p.text.startsWith('Context compacted:'));
		expect(hasCompactInfo).toBeFalsy();
	});

	it('honors the legacy promptTokens / promptTokensDetails usage shape', async () => {
		// Older OpenRouter rows use {promptTokens, promptTokensDetails: {cachedTokens}}.
		// The DO falls back to that shape when modern keys are absent.
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		await setSetting(env, 'context_compaction_threshold', '50');

		await seedMessages(stub, [
			{ content: 'q0', createdAt: 100, id: 'u0', role: 'user' },
			{ content: 'a0', createdAt: 101, id: 'a0', model: 'fake/model', role: 'assistant' },
			{ content: 'q1', createdAt: 102, id: 'u1', role: 'user' },
			{ content: 'a1', createdAt: 103, id: 'a1', model: 'fake/model', role: 'assistant' },
			{ content: 'q2', createdAt: 104, id: 'u2', role: 'user' },
			{
				content: 'a2',
				createdAt: 105,
				id: 'a2',
				model: 'fake/model',
				role: 'assistant',
				usage_json: JSON.stringify({
					promptTokens: 1500,
					promptTokensDetails: { cachedTokens: 0 },
				}),
			},
		]);

		await setOverride(stub, [textTurn('LEGACY-SUMMARY').events, textTurn('legacy reply').events]);
		await stub.addUserMessage(id, 'go', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', { timeoutMs: 5000 });

		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(2); // summary + generate
		expect(calls[1].messages[0].role).toBe('system');
		expect(calls[1].messages[0].content).toContain('LEGACY-SUMMARY');
	});

	it('excludes soft-deleted rows from the history sent to the LLM', async () => {
		// Regression: rows already soft-deleted by a previous compactContext
		// must not reappear in `#generate`'s history rebuild. If they did,
		// the compaction summary would be redundant and the LLM would re-see
		// the dropped transcript.
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		await setSetting(env, 'context_compaction_threshold', '0'); // no auto-compact path

		await seedMessages(stub, [
			{
				content: 'OLD-SECRET',
				createdAt: 50,
				deletedAt: 60,
				id: 'old0',
				role: 'user',
			},
			{
				content: 'OLD-RESPONSE',
				createdAt: 51,
				deletedAt: 60,
				id: 'old1',
				model: 'fake/model',
				role: 'assistant',
			},
			{ content: 'visible q', createdAt: 100, id: 'u0', role: 'user' },
			{
				content: 'visible a',
				createdAt: 101,
				id: 'a0',
				model: 'fake/model',
				role: 'assistant',
			},
		]);

		await setOverride(stub, [textTurn('reply').events]);
		await stub.addUserMessage(id, 'next', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', { timeoutMs: 5000 });

		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(1);
		const flat = calls[0].messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
		// Soft-deleted content must not have leaked back into the request.
		expect(flat.some((c) => c.includes('OLD-SECRET'))).toBe(false);
		expect(flat.some((c) => c.includes('OLD-RESPONSE'))).toBe(false);
		expect(flat.some((c) => c.includes('visible q'))).toBe(true);
	});

	it('captures the maxTokens budget for the summarization call from settings', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await registerFakeModel(2000);
		await setSetting(env, 'context_compaction_threshold', '50');
		await setSetting(env, 'context_compaction_summary_tokens', '2048');

		const filler = 'lorem ipsum dolor sit amet '.repeat(80);
		await seedMessages(stub, [
			{ content: `q0 ${filler}`, createdAt: 100, id: 'u0', role: 'user' },
			{ content: `a0 ${filler}`, createdAt: 101, id: 'a0', model: 'fake/model', role: 'assistant' },
			{ content: `q1 ${filler}`, createdAt: 102, id: 'u1', role: 'user' },
			{ content: `a1 ${filler}`, createdAt: 103, id: 'a1', model: 'fake/model', role: 'assistant' },
			{ content: `q2 ${filler}`, createdAt: 104, id: 'u2', role: 'user' },
			{
				content: `a2 ${filler}`,
				createdAt: 105,
				id: 'a2',
				model: 'fake/model',
				role: 'assistant',
				usage_json: JSON.stringify({ inputTokens: 1500 }),
			},
		]);

		await setOverride(stub, [textTurn('SUM').events, textTurn('reply').events]);
		await stub.addUserMessage(id, 'go', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', { timeoutMs: 5000 });

		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(2);
		const summaryCall: ChatRequest = calls[0];
		expect(summaryCall.maxTokens).toBe(2048);
	});
});
