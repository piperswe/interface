import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModel } from '../providers/models';
import { createProvider } from '../providers/store';
import { setSetting } from '../settings';
import { compactHistory } from './context';
import type { ChatRequest, Message, StreamEvent } from './LLM';
import * as routeMod from './route';

afterEach(async () => {
	vi.restoreAllMocks();
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
});

beforeEach(async () => {
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
});

async function setupModel(contextLength: number) {
	await createProvider(env, { apiKey: 'sk-test', endpoint: 'https://api.openai.com/v1', id: 'test', type: 'openai_compatible' });
	await createModel(env, 'test', { id: 'model', maxContextLength: contextLength, name: 'Test' });
}

function mockSummary(text: string) {
	async function* gen(): AsyncGenerator<StreamEvent> {
		yield { delta: text, type: 'text_delta' };
		yield { type: 'done' };
	}
	vi.spyOn(routeMod, 'routeLLMByGlobalId').mockResolvedValue({
		chat: () => gen(),
		model: 'test/model',
		providerID: 'mock',
	} as never);
}

describe('compactHistory', () => {
	it('is a no-op when threshold is 0', async () => {
		await setSetting(env, 'context_compaction_threshold', '0');
		const messages: Message[] = [{ content: 'hi', role: 'user' }];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(false);
		expect(out.messages).toEqual(messages);
	});

	it('is a no-op when the estimated token count fits', async () => {
		await setSetting(env, 'context_compaction_threshold', '80');
		await setupModel(1_000_000);
		const messages: Message[] = [{ content: 'hi', role: 'user' }];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(false);
	});

	it('refuses to compact short conversations even when over budget', async () => {
		await setSetting(env, 'context_compaction_threshold', '80');
		await setupModel(100); // tiny — anything is "over budget"
		mockSummary('SUMMARY');
		const messages: Message[] = [
			{ content: 'q1', role: 'user' },
			{ content: 'a1', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(false);
		expect(out.messages).toEqual(messages);
	});

	it('drops oldest messages and prepends a summary when over budget', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		mockSummary('SUMMARY OF EARLIER TURNS');
		// Build six messages with enough text to definitely overflow 50% of 2000 tokens.
		const big = 'lorem ipsum dolor sit amet '.repeat(80); // ~2150 chars → ~590 tokens
		const messages: Message[] = [
			{ content: `${big} u1`, role: 'user' },
			{ content: `${big} a1`, role: 'assistant' },
			{ content: `${big} u2`, role: 'user' },
			{ content: `${big} a2`, role: 'assistant' },
			{ content: 'recent question', role: 'user' },
			{ content: 'recent answer', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
		expect(out.droppedCount).toBeGreaterThan(0);
		expect(out.summary).toContain('SUMMARY OF EARLIER TURNS');
		expect(out.messages[0].role).toBe('system');
		const last = out.messages.at(-1);
		expect(last?.content).toBe('recent answer');
	});

	it('uses the lastUsage hint when provided', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		mockSummary('SUMMARY');
		const messages: Message[] = [
			{ content: 'tiny', role: 'user' },
			{ content: 'tiny', role: 'assistant' },
			{ content: 'tiny', role: 'user' },
			{ content: 'tiny', role: 'assistant' },
			{ content: 'tiny', role: 'user' },
			{ content: 'tiny', role: 'assistant' },
		];
		// lastUsage says 5000 input tokens — that's way over 50% of 2000 (1000).
		const out = await compactHistory(messages, 'test/model', env, { inputTokens: 5000 });
		expect(out.wasCompacted).toBe(true);
	});

	it('falls back to raw transcript when the summarisation LLM errors', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		async function* erroring(): AsyncGenerator<StreamEvent> {
			yield { message: 'boom', type: 'error' };
		}
		vi.spyOn(routeMod, 'routeLLMByGlobalId').mockResolvedValue({
			chat: () => erroring(),
			model: 'test/model',
			providerID: 'mock',
		} as never);
		const big = 'lorem ipsum dolor sit amet '.repeat(80);
		const messages: Message[] = [
			{ content: `${big} u1`, role: 'user' },
			{ content: `${big} a1`, role: 'assistant' },
			{ content: `${big} u2`, role: 'user' },
			{ content: `${big} a2`, role: 'assistant' },
			{ content: 'recent', role: 'user' },
			{ content: 'recent', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
		// Summary contains the raw dropped text fallback.
		expect(out.summary).toMatch(/lorem ipsum/);
	});

	it('counts text-block tokens in structured content', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		mockSummary('SUMMARY');
		const big = 'lorem ipsum '.repeat(200);
		const messages: Message[] = [
			{ content: [{ text: big, type: 'text' }], role: 'user' },
			{ content: [{ text: big, type: 'text' }], role: 'assistant' },
			{ content: [{ text: big, type: 'text' }], role: 'user' },
			{ content: [{ text: big, type: 'text' }], role: 'assistant' },
			{ content: 'recent', role: 'user' },
			{ content: 'recent', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
	});

	it('counts tool_use and tool_result blocks toward the budget', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		mockSummary('SUMMARY');
		// Each tool_result carries a chunk of text large enough to push the
		// total past 50% of 2000 tokens, even though the surrounding text
		// blocks are tiny. Without tool-block accounting these would all fit.
		const bigResult = 'x'.repeat(2000);
		const messages: Message[] = [
			{
				content: [{ id: 't1', input: { q: 'a' }, name: 'search', type: 'tool_use' }],
				role: 'assistant',
			},
			{ content: [{ content: bigResult, toolUseId: 't1', type: 'tool_result' }], role: 'tool' },
			{
				content: [{ id: 't2', input: { q: 'b' }, name: 'search', type: 'tool_use' }],
				role: 'assistant',
			},
			{ content: [{ content: bigResult, toolUseId: 't2', type: 'tool_result' }], role: 'tool' },
			{ content: 'final', role: 'user' },
			{ content: 'done', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
		expect(out.droppedCount).toBeGreaterThan(0);
	});

	it('treats high cacheReadInputTokens as effectively cheap input', async () => {
		// Regression: cached tokens shouldn't trigger compaction. A 5000-token
		// reported usage where 4900 were cache hits leaves 100 effective input
		// tokens (+1024 safety margin = 1124) — under 50% of a 4000-token
		// window (2000).
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(4000);
		const messages: Message[] = [
			{ content: 'q1', role: 'user' },
			{ content: 'a1', role: 'assistant' },
			{ content: 'q2', role: 'user' },
			{ content: 'a2', role: 'assistant' },
			{ content: 'q3', role: 'user' },
			{ content: 'a3', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, {
			cacheReadInputTokens: 4900,
			inputTokens: 5000,
		});
		expect(out.wasCompacted).toBe(false);
	});

	it('summary message is prefixed and assigned to role:system', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		mockSummary('THE-SUMMARY');
		const big = 'lorem ipsum dolor sit amet '.repeat(80);
		const messages: Message[] = [
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: 'recent q', role: 'user' },
			{ content: 'recent a', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
		expect(out.messages[0].role).toBe('system');
		expect(out.messages[0].content).toMatch(/^Previous conversation summary: /);
		expect(out.messages[0].content).toContain('THE-SUMMARY');
	});

	it('droppedCount matches the actual number of removed messages', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		mockSummary('SUMMARY');
		const big = 'lorem ipsum dolor sit amet '.repeat(80);
		const messages: Message[] = [
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: 'recent q', role: 'user' },
			{ content: 'recent a', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
		// remaining = original (excluding summary) + 1 system prepend.
		expect(out.messages.length).toBe(messages.length - out.droppedCount + 1);
	});

	it('preserves at least the most-recent four messages in original order', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		mockSummary('SUMMARY');
		const big = 'lorem ipsum dolor sit amet '.repeat(80);
		const messages: Message[] = [
			{ content: `old q1 ${big}`, role: 'user' },
			{ content: `old a1 ${big}`, role: 'assistant' },
			{ content: `old q2 ${big}`, role: 'user' },
			{ content: `old a2 ${big}`, role: 'assistant' },
			{ content: 'kept q3', role: 'user' },
			{ content: 'kept a3', role: 'assistant' },
			{ content: 'kept q4', role: 'user' },
			{ content: 'kept a4', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
		// First message is the summary; the last four must equal the original
		// last four in order.
		const tail = out.messages.slice(-4);
		expect(tail[0].content).toBe('kept q3');
		expect(tail[1].content).toBe('kept a3');
		expect(tail[2].content).toBe('kept q4');
		expect(tail[3].content).toBe('kept a4');
	});

	it('does not compact when there are exactly four messages even if over budget', async () => {
		// The minKeep guard is `messages.length <= minKeep` with minKeep=4, so
		// a 4-message conversation can never compact.
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(100);
		mockSummary('SUMMARY');
		const big = 'lorem ipsum '.repeat(50);
		const messages: Message[] = [
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(false);
		expect(out.messages).toEqual(messages);
	});

	it('drops as many messages as fit when no slice meets the budget', async () => {
		// 5 messages with 100-token window: even keeping just the last 4 will
		// be over budget. compactHistory must still drop at most maxDropIndex
		// (1 here) and stop — minKeep is sacred.
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(100);
		mockSummary('SUMMARY');
		const big = 'lorem ipsum '.repeat(80);
		const messages: Message[] = [
			{ content: `m0 ${big}`, role: 'user' },
			{ content: `m1 ${big}`, role: 'assistant' },
			{ content: `m2 ${big}`, role: 'user' },
			{ content: `m3 ${big}`, role: 'assistant' },
			{ content: `m4 ${big}`, role: 'user' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
		// minKeep is min(4, 5) = 4, so droppedCount must be exactly 1.
		expect(out.droppedCount).toBe(1);
		// Last four must equal the original last four.
		const tail = out.messages.slice(-4);
		expect(tail.map((m) => m.content)).toEqual([messages[1].content, messages[2].content, messages[3].content, messages[4].content]);
	});

	it('forwards the configured summary token budget to the summarization LLM', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setSetting(env, 'context_compaction_summary_tokens', '4096');
		await setupModel(2000);
		const calls: ChatRequest[] = [];
		async function* gen(req: ChatRequest): AsyncGenerator<StreamEvent> {
			calls.push(req);
			yield { delta: 'SUMMARY', type: 'text_delta' };
			yield { type: 'done' };
		}
		vi.spyOn(routeMod, 'routeLLMByGlobalId').mockResolvedValue({
			chat: (req: ChatRequest) => gen(req),
			model: 'test/model',
			providerID: 'mock',
		} as never);
		const big = 'lorem ipsum dolor sit amet '.repeat(80);
		const messages: Message[] = [
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: 'recent', role: 'user' },
			{ content: 'recent', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].maxTokens).toBe(4096);
	});

	it('routes through the deps.llm injector when provided', async () => {
		// Confirms the dependency seam used by ConversationDurableObject — the
		// DO injects its own #routeLLM so the override script catches the
		// summarization call. If deps.llm isn't honored the spy would never fire.
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		// Mocking routeLLMByGlobalId to a function that throws — if compact
		// reaches it, the test fails. Only the injected llm() should be called.
		const routeSpy = vi.spyOn(routeMod, 'routeLLMByGlobalId').mockImplementation(async () => {
			throw new Error('should not be reached');
		});
		const injected = vi.fn(async () => ({
			chat: async function* () {
				yield { delta: 'INJECTED', type: 'text_delta' } as StreamEvent;
				yield { type: 'done' } as StreamEvent;
			},
			model: 'test/model',
			providerID: 'inj',
		}));
		const big = 'lorem ipsum dolor sit amet '.repeat(80);
		const messages: Message[] = [
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: 'recent', role: 'user' },
			{ content: 'recent', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'test/model', env, null, {
			llm: injected as never,
		});
		expect(out.wasCompacted).toBe(true);
		expect(out.summary).toBe('INJECTED');
		expect(injected).toHaveBeenCalledTimes(1);
		expect(routeSpy).not.toHaveBeenCalled();
	});

	it('force=true compacts even when threshold=0 disables auto-compaction', async () => {
		// Manual `compactContext` calls from the DO use force=true to bypass
		// the user-configured threshold. With threshold=0 and no force,
		// compaction is a no-op; with force=true the 50% ceiling kicks in.
		await setSetting(env, 'context_compaction_threshold', '0');
		await setupModel(2000);
		mockSummary('FORCED-SUMMARY');
		const big = 'lorem ipsum dolor sit amet '.repeat(80);
		const messages: Message[] = [
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: big, role: 'user' },
			{ content: big, role: 'assistant' },
			{ content: 'recent q', role: 'user' },
			{ content: 'recent a', role: 'assistant' },
		];
		const noForce = await compactHistory(messages, 'test/model', env, null);
		expect(noForce.wasCompacted).toBe(false);
		const forced = await compactHistory(messages, 'test/model', env, null, {}, true);
		expect(forced.wasCompacted).toBe(true);
		expect(forced.summary).toContain('FORCED-SUMMARY');
	});

	it('falls back to a 128k context window when the model is unknown', async () => {
		// No provider/model row exists → resolved is null → contextWindow=128_000.
		// 6 small messages can't exceed 50% of 128k, so this is a no-op.
		await setSetting(env, 'context_compaction_threshold', '50');
		const messages: Message[] = [
			{ content: 'q1', role: 'user' },
			{ content: 'a1', role: 'assistant' },
			{ content: 'q2', role: 'user' },
			{ content: 'a2', role: 'assistant' },
			{ content: 'q3', role: 'user' },
			{ content: 'a3', role: 'assistant' },
		];
		const out = await compactHistory(messages, 'unknown/missing', env, null);
		expect(out.wasCompacted).toBe(false);
	});
});
