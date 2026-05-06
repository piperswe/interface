import { describe, expect, it } from 'vitest';
import { computeCost, computeConversationCost, countWebSearches } from './cost';
import type { MessagePart, MessageRow } from '$lib/types/conversation';

describe('computeCost', () => {
	const model = {
		inputCostPerMillionTokens: 3,
		outputCostPerMillionTokens: 15,
	};

	it('returns null when usage is missing', () => {
		expect(
			computeCost({
				usage: null,
				model,
				webSearchCount: 0,
				kagiCostPer1000Searches: 25,
			}).total,
		).toBeNull();
	});

	it('uses provider-reported cost when present', () => {
		const result = computeCost({
			usage: { inputTokens: 1000, outputTokens: 500, cost: 0.42 },
			model,
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		expect(result.llmCost).toBe(0.42);
		expect(result.total).toBe(0.42);
	});

	it('falls back to per-million pricing when provider does not report cost', () => {
		const result = computeCost({
			usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
			model,
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		// 1M * $3/M + 0.5M * $15/M = $3 + $7.5 = $10.5
		expect(result.llmCost).toBeCloseTo(10.5, 6);
		expect(result.total).toBeCloseTo(10.5, 6);
	});

	it('bills cache-read and cache-write tokens at the input rate', () => {
		const result = computeCost({
			usage: {
				inputTokens: 1_000_000,
				outputTokens: 0,
				cacheReadInputTokens: 500_000,
				cacheCreationInputTokens: 200_000,
			},
			model,
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		// (1.0M + 0.5M + 0.2M) * $3/M = $5.1
		expect(result.llmCost).toBeCloseTo(5.1, 6);
	});

	it('returns null LLM cost when no provider cost and no per-million rates', () => {
		const result = computeCost({
			usage: { inputTokens: 100, outputTokens: 50 },
			model: { inputCostPerMillionTokens: null, outputCostPerMillionTokens: null },
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		expect(result.llmCost).toBeNull();
		expect(result.total).toBeNull();
	});

	it('adds Kagi search cost on top of LLM cost', () => {
		const result = computeCost({
			usage: { inputTokens: 0, outputTokens: 0, cost: 0.1 },
			model,
			webSearchCount: 4,
			kagiCostPer1000Searches: 25,
		});
		// 4 / 1000 * $25 = $0.10
		expect(result.webSearchCost).toBeCloseTo(0.1, 6);
		expect(result.total).toBeCloseTo(0.2, 6);
	});

	it('reports search cost even when LLM cost is unknown', () => {
		const result = computeCost({
			usage: { inputTokens: 0, outputTokens: 0 },
			model: null,
			webSearchCount: 10,
			kagiCostPer1000Searches: 25,
		});
		expect(result.llmCost).toBeNull();
		expect(result.webSearchCost).toBeCloseTo(0.25, 6);
		expect(result.total).toBeCloseTo(0.25, 6);
	});

	it('honours a custom Kagi cost', () => {
		const result = computeCost({
			usage: null,
			model: null,
			webSearchCount: 100,
			kagiCostPer1000Searches: 5,
		});
		// 100 / 1000 * $5 = $0.50
		expect(result.total).toBeCloseTo(0.5, 6);
	});

	it('handles partial pricing (only input rate set)', () => {
		const result = computeCost({
			usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
			model: { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: null },
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		expect(result.llmCost).toBeCloseTo(2, 6);
	});

	it('handles partial pricing (only output rate set)', () => {
		const result = computeCost({
			usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
			model: { inputCostPerMillionTokens: null, outputCostPerMillionTokens: 8 },
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		// 0.5M * $8/M = $4
		expect(result.llmCost).toBeCloseTo(4, 6);
	});

	it('falls back to per-million pricing when usage.cost is NaN', () => {
		// NaN is not "finite" → falls through to per-million pricing.
		const result = computeCost({
			usage: { inputTokens: 1_000_000, outputTokens: 0, cost: NaN },
			model,
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		expect(result.llmCost).toBeCloseTo(3, 6);
	});

	it('falls back to per-million pricing when usage.cost is Infinity', () => {
		const result = computeCost({
			usage: { inputTokens: 1_000_000, outputTokens: 0, cost: Infinity },
			model,
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		expect(result.llmCost).toBeCloseTo(3, 6);
	});

	it('treats undefined token fields as zero', () => {
		const result = computeCost({
			usage: { inputTokens: 1_000_000 } as never,
			model,
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		// outputTokens defaults to 0; only input is billed.
		expect(result.llmCost).toBeCloseTo(3, 6);
	});

	it('webSearchCost is zero when count is zero, NaN, negative, or kagi cost is invalid', () => {
		const baseModel = { inputCostPerMillionTokens: null, outputCostPerMillionTokens: null };
		expect(
			computeCost({ usage: null, model: baseModel, webSearchCount: 0, kagiCostPer1000Searches: 25 })
				.webSearchCost,
		).toBe(0);
		expect(
			computeCost({
				usage: null,
				model: baseModel,
				webSearchCount: NaN as number,
				kagiCostPer1000Searches: 25,
			}).webSearchCost,
		).toBe(0);
		expect(
			computeCost({
				usage: null,
				model: baseModel,
				webSearchCount: -3,
				kagiCostPer1000Searches: 25,
			}).webSearchCost,
		).toBe(0);
		// Invalid kagi cost falls back to 0.
		expect(
			computeCost({
				usage: null,
				model: baseModel,
				webSearchCount: 10,
				kagiCostPer1000Searches: NaN as number,
			}).webSearchCost,
		).toBe(0);
		expect(
			computeCost({
				usage: null,
				model: baseModel,
				webSearchCount: 10,
				kagiCostPer1000Searches: -5,
			}).webSearchCost,
		).toBe(0);
	});

	it('total stays null when both LLM cost is null and search cost is zero', () => {
		const result = computeCost({
			usage: null,
			model: null,
			webSearchCount: 0,
			kagiCostPer1000Searches: 25,
		});
		expect(result.total).toBeNull();
		expect(result.webSearchCost).toBe(0);
	});
});

describe('computeConversationCost', () => {
	const pricing = { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 15 };
	const lookup = (id: string) => (id === 'p/m' ? pricing : null);

	function asst(over: Partial<MessageRow>): MessageRow {
		return {
			id: 'a',
			role: 'assistant',
			content: '',
			model: 'p/m',
			status: 'complete',
			error: null,
			createdAt: 0,
			meta: null,
			...over,
		};
	}

	it('returns null total for an empty conversation', () => {
		expect(computeConversationCost([], lookup, 25).total).toBeNull();
	});

	it('skips user messages when summing', () => {
		const messages: MessageRow[] = [
			{
				id: 'u',
				role: 'user',
				content: 'hi',
				model: null,
				status: 'complete',
				error: null,
				createdAt: 0,
				meta: { startedAt: 0, firstTokenAt: 0, lastChunk: null, usage: { inputTokens: 999, outputTokens: 999, cost: 9 } },
			},
			asst({
				id: 'a1',
				meta: { startedAt: 0, firstTokenAt: 0, lastChunk: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0.5 } },
			}),
		];
		const result = computeConversationCost(messages, lookup, 25);
		expect(result.total).toBeCloseTo(0.5, 6);
	});

	it('sums LLM cost across multiple assistant turns', () => {
		const messages: MessageRow[] = [
			asst({
				id: 'a1',
				meta: { startedAt: 0, firstTokenAt: 0, lastChunk: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0.25 } },
			}),
			asst({
				id: 'a2',
				meta: { startedAt: 0, firstTokenAt: 0, lastChunk: null, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
			}),
		];
		// 0.25 (provider) + 1M * $3/M = $3.25
		const result = computeConversationCost(messages, lookup, 25);
		expect(result.llmCost).toBeCloseTo(3.25, 6);
		expect(result.total).toBeCloseTo(3.25, 6);
	});

	it('aggregates Kagi search cost across turns', () => {
		const parts: MessagePart[] = [
			{ type: 'tool_use', id: 't', name: 'web_search', input: {} },
			{ type: 'tool_use', id: 't2', name: 'web_search', input: {} },
		];
		const messages: MessageRow[] = [
			asst({ id: 'a1', meta: null, parts }),
			asst({ id: 'a2', meta: null, parts: [{ type: 'tool_use', id: 't3', name: 'web_search', input: {} }] }),
		];
		// 3 searches * $25/1000 = $0.075
		const result = computeConversationCost(messages, lookup, 25);
		expect(result.webSearchCost).toBeCloseTo(0.075, 6);
		expect(result.llmCost).toBeNull();
		expect(result.total).toBeCloseTo(0.075, 6);
	});

	it('skips tool messages and counts only assistant turns', () => {
		const messages: MessageRow[] = [
			asst({
				id: 'a1',
				meta: { startedAt: 0, firstTokenAt: 0, lastChunk: null, usage: { inputTokens: 0, outputTokens: 0, cost: 1 } },
			}),
			{
				id: 't1',
				role: 'tool',
				content: 'tool output',
				model: null,
				status: 'complete',
				error: null,
				createdAt: 0,
				meta: { startedAt: 0, firstTokenAt: 0, lastChunk: null, usage: { inputTokens: 99, outputTokens: 99, cost: 99 } },
			},
		];
		const result = computeConversationCost(messages, lookup, 25);
		expect(result.llmCost).toBeCloseTo(1, 6);
	});

	it('contributes zero LLM cost for messages whose model is no longer registered', () => {
		// Regression: removed/renamed models used to error or null out the
		// conversation total. They now contribute zero LLM cost (and any
		// provider-reported cost is still honoured) instead of poisoning the sum.
		const messages: MessageRow[] = [
			asst({ id: 'a1', model: 'unknown/model', meta: { startedAt: 0, firstTokenAt: 0, lastChunk: null, usage: { inputTokens: 100, outputTokens: 50 } } }),
			asst({ id: 'a2', meta: { startedAt: 0, firstTokenAt: 0, lastChunk: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0.4 } } }),
		];
		const result = computeConversationCost(messages, lookup, 25);
		expect(result.llmCost).toBeCloseTo(0.4, 6);
	});
});

describe('countWebSearches', () => {
	it('returns 0 for null/empty parts', () => {
		expect(countWebSearches(null)).toBe(0);
		expect(countWebSearches([])).toBe(0);
	});

	it('counts web_search tool_use parts only', () => {
		const parts: MessagePart[] = [
			{ type: 'text', text: 'searching…' },
			{ type: 'tool_use', id: '1', name: 'web_search', input: { query: 'a' } },
			{ type: 'tool_use', id: '2', name: 'fetch_url', input: {} },
			{ type: 'tool_use', id: '3', name: 'web_search', input: { query: 'b' } },
		];
		expect(countWebSearches(parts)).toBe(2);
	});

	it('respects extraNames', () => {
		const parts: MessagePart[] = [
			{ type: 'tool_use', id: '1', name: 'web_search', input: {} },
			{ type: 'tool_use', id: '2', name: 'kagi_search', input: {} },
		];
		expect(countWebSearches(parts, ['kagi_search'])).toBe(2);
	});

	it('does not double-count when a name appears in both the default set and extraNames', () => {
		const parts: MessagePart[] = [
			{ type: 'tool_use', id: '1', name: 'web_search', input: {} },
		];
		// 'web_search' is built-in; passing it in extraNames again should not
		// matter (Set dedupe).
		expect(countWebSearches(parts, ['web_search'])).toBe(1);
	});

	it('ignores tool_result and text parts even when their text mentions web_search', () => {
		const parts: MessagePart[] = [
			{ type: 'text', text: 'I called web_search' },
			{ type: 'tool_result', toolUseId: 't1', content: 'web_search results', isError: false },
		];
		expect(countWebSearches(parts)).toBe(0);
	});
});
