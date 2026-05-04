import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compactHistory } from './context';
import type { Message, StreamEvent } from './LLM';
import * as routeMod from './route';
import { createProvider } from '../providers/store';
import { createModel } from '../providers/models';
import { setSetting } from '../settings';

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
	await createProvider(env, { id: 'test', type: 'openai_compatible', apiKey: 'sk-test', endpoint: 'https://api.openai.com/v1' });
	await createModel(env, 'test', { id: 'model', name: 'Test', maxContextLength: contextLength });
}

function mockSummary(text: string) {
	async function* gen(): AsyncGenerator<StreamEvent> {
		yield { type: 'text_delta', delta: text };
		yield { type: 'done' };
	}
	vi.spyOn(routeMod, 'routeLLMByGlobalId').mockResolvedValue({
		model: 'test/model',
		providerID: 'mock',
		chat: () => gen(),
	} as never);
}

describe('compactHistory', () => {
	it('is a no-op when threshold is 0', async () => {
		await setSetting(env, 'context_compaction_threshold', '0');
		const messages: Message[] = [{ role: 'user', content: 'hi' }];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(false);
		expect(out.messages).toEqual(messages);
	});

	it('is a no-op when the estimated token count fits', async () => {
		await setSetting(env, 'context_compaction_threshold', '80');
		await setupModel(1_000_000);
		const messages: Message[] = [{ role: 'user', content: 'hi' }];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(false);
	});

	it('refuses to compact short conversations even when over budget', async () => {
		await setSetting(env, 'context_compaction_threshold', '80');
		await setupModel(100); // tiny — anything is "over budget"
		mockSummary('SUMMARY');
		const messages: Message[] = [
			{ role: 'user', content: 'q1' },
			{ role: 'assistant', content: 'a1' },
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
			{ role: 'user', content: big + ' u1' },
			{ role: 'assistant', content: big + ' a1' },
			{ role: 'user', content: big + ' u2' },
			{ role: 'assistant', content: big + ' a2' },
			{ role: 'user', content: 'recent question' },
			{ role: 'assistant', content: 'recent answer' },
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
			{ role: 'user', content: 'tiny' },
			{ role: 'assistant', content: 'tiny' },
			{ role: 'user', content: 'tiny' },
			{ role: 'assistant', content: 'tiny' },
			{ role: 'user', content: 'tiny' },
			{ role: 'assistant', content: 'tiny' },
		];
		// lastUsage says 5000 input tokens — that's way over 50% of 2000 (1000).
		const out = await compactHistory(messages, 'test/model', env, { inputTokens: 5000 });
		expect(out.wasCompacted).toBe(true);
	});

	it('falls back to raw transcript when the summarisation LLM errors', async () => {
		await setSetting(env, 'context_compaction_threshold', '50');
		await setupModel(2000);
		async function* erroring(): AsyncGenerator<StreamEvent> {
			yield { type: 'error', message: 'boom' };
		}
		vi.spyOn(routeMod, 'routeLLMByGlobalId').mockResolvedValue({
			model: 'test/model',
			providerID: 'mock',
			chat: () => erroring(),
		} as never);
		const big = 'lorem ipsum dolor sit amet '.repeat(80);
		const messages: Message[] = [
			{ role: 'user', content: big + ' u1' },
			{ role: 'assistant', content: big + ' a1' },
			{ role: 'user', content: big + ' u2' },
			{ role: 'assistant', content: big + ' a2' },
			{ role: 'user', content: 'recent' },
			{ role: 'assistant', content: 'recent' },
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
			{ role: 'user', content: [{ type: 'text', text: big }] },
			{ role: 'assistant', content: [{ type: 'text', text: big }] },
			{ role: 'user', content: [{ type: 'text', text: big }] },
			{ role: 'assistant', content: [{ type: 'text', text: big }] },
			{ role: 'user', content: 'recent' },
			{ role: 'assistant', content: 'recent' },
		];
		const out = await compactHistory(messages, 'test/model', env, null);
		expect(out.wasCompacted).toBe(true);
	});
});
