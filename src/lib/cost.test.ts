import { describe, expect, it } from 'vitest';
import type { MessagePart, MessageRow } from '$lib/types/conversation';
import { computeConversationCost, computeCost, countWebSearches } from './cost';

describe('computeCost', () => {
	const model = {
		inputCostPerMillionTokens: 3,
		outputCostPerMillionTokens: 15,
	};

	it('returns null when usage is missing', () => {
		expect(
			computeCost({
				kagiCostPer1000Searches: 25,
				model,
				usage: null,
				webSearchCount: 0,
			}).total,
		).toBeNull();
	});

	it('uses provider-reported cost when present', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model,
			usage: { cost: 0.42, inputTokens: 1000, outputTokens: 500 },
			webSearchCount: 0,
		});
		expect(result.llmCost).toBe(0.42);
		expect(result.total).toBe(0.42);
	});

	it('falls back to per-million pricing when provider does not report cost', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model,
			usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
			webSearchCount: 0,
		});
		// 1M * $3/M + 0.5M * $15/M = $3 + $7.5 = $10.5
		expect(result.llmCost).toBeCloseTo(10.5, 6);
		expect(result.total).toBeCloseTo(10.5, 6);
	});

	it('bills cache-read and cache-write tokens at the input rate', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model,
			usage: {
				cacheCreationInputTokens: 200_000,
				cacheReadInputTokens: 500_000,
				inputTokens: 1_000_000,
				outputTokens: 0,
			},
			webSearchCount: 0,
		});
		// (1.0M + 0.5M + 0.2M) * $3/M = $5.1
		expect(result.llmCost).toBeCloseTo(5.1, 6);
	});

	it('returns null LLM cost when no provider cost and no per-million rates', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model: { inputCostPerMillionTokens: null, outputCostPerMillionTokens: null },
			usage: { inputTokens: 100, outputTokens: 50 },
			webSearchCount: 0,
		});
		expect(result.llmCost).toBeNull();
		expect(result.total).toBeNull();
	});

	it('adds Kagi search cost on top of LLM cost', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model,
			usage: { cost: 0.1, inputTokens: 0, outputTokens: 0 },
			webSearchCount: 4,
		});
		// 4 / 1000 * $25 = $0.10
		expect(result.webSearchCost).toBeCloseTo(0.1, 6);
		expect(result.total).toBeCloseTo(0.2, 6);
	});

	it('reports search cost even when LLM cost is unknown', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model: null,
			usage: { inputTokens: 0, outputTokens: 0 },
			webSearchCount: 10,
		});
		expect(result.llmCost).toBeNull();
		expect(result.webSearchCost).toBeCloseTo(0.25, 6);
		expect(result.total).toBeCloseTo(0.25, 6);
	});

	it('honours a custom Kagi cost', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 5,
			model: null,
			usage: null,
			webSearchCount: 100,
		});
		// 100 / 1000 * $5 = $0.50
		expect(result.total).toBeCloseTo(0.5, 6);
	});

	it('handles partial pricing (only input rate set)', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model: { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: null },
			usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
			webSearchCount: 0,
		});
		expect(result.llmCost).toBeCloseTo(2, 6);
	});

	it('handles partial pricing (only output rate set)', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model: { inputCostPerMillionTokens: null, outputCostPerMillionTokens: 8 },
			usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
			webSearchCount: 0,
		});
		// 0.5M * $8/M = $4
		expect(result.llmCost).toBeCloseTo(4, 6);
	});

	it('falls back to per-million pricing when usage.cost is NaN', () => {
		// NaN is not "finite" → falls through to per-million pricing.
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model,
			usage: { cost: NaN, inputTokens: 1_000_000, outputTokens: 0 },
			webSearchCount: 0,
		});
		expect(result.llmCost).toBeCloseTo(3, 6);
	});

	it('falls back to per-million pricing when usage.cost is Infinity', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model,
			usage: { cost: Infinity, inputTokens: 1_000_000, outputTokens: 0 },
			webSearchCount: 0,
		});
		expect(result.llmCost).toBeCloseTo(3, 6);
	});

	it('treats undefined token fields as zero', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model,
			usage: { inputTokens: 1_000_000 } as never,
			webSearchCount: 0,
		});
		// outputTokens defaults to 0; only input is billed.
		expect(result.llmCost).toBeCloseTo(3, 6);
	});

	it('webSearchCost is zero when count is zero, NaN, negative, or kagi cost is invalid', () => {
		const baseModel = { inputCostPerMillionTokens: null, outputCostPerMillionTokens: null };
		expect(computeCost({ kagiCostPer1000Searches: 25, model: baseModel, usage: null, webSearchCount: 0 }).webSearchCost).toBe(0);
		expect(
			computeCost({
				kagiCostPer1000Searches: 25,
				model: baseModel,
				usage: null,
				webSearchCount: NaN as number,
			}).webSearchCost,
		).toBe(0);
		expect(
			computeCost({
				kagiCostPer1000Searches: 25,
				model: baseModel,
				usage: null,
				webSearchCount: -3,
			}).webSearchCost,
		).toBe(0);
		// Invalid kagi cost falls back to 0.
		expect(
			computeCost({
				kagiCostPer1000Searches: NaN as number,
				model: baseModel,
				usage: null,
				webSearchCount: 10,
			}).webSearchCost,
		).toBe(0);
		expect(
			computeCost({
				kagiCostPer1000Searches: -5,
				model: baseModel,
				usage: null,
				webSearchCount: 10,
			}).webSearchCost,
		).toBe(0);
	});

	it('total stays null when both LLM cost is null and search cost is zero', () => {
		const result = computeCost({
			kagiCostPer1000Searches: 25,
			model: null,
			usage: null,
			webSearchCount: 0,
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
			content: '',
			createdAt: 0,
			error: null,
			id: 'a',
			meta: null,
			model: 'p/m',
			role: 'assistant',
			status: 'complete',
			...over,
		};
	}

	it('returns null total for an empty conversation', () => {
		expect(computeConversationCost([], lookup, 25).total).toBeNull();
	});

	it('skips user messages when summing', () => {
		const messages: MessageRow[] = [
			{
				content: 'hi',
				createdAt: 0,
				error: null,
				id: 'u',
				meta: { firstTokenAt: 0, lastChunk: null, startedAt: 0, usage: { cost: 9, inputTokens: 999, outputTokens: 999 } },
				model: null,
				role: 'user',
				status: 'complete',
			},
			asst({
				id: 'a1',
				meta: { firstTokenAt: 0, lastChunk: null, startedAt: 0, usage: { cost: 0.5, inputTokens: 0, outputTokens: 0 } },
			}),
		];
		const result = computeConversationCost(messages, lookup, 25);
		expect(result.total).toBeCloseTo(0.5, 6);
	});

	it('sums LLM cost across multiple assistant turns', () => {
		const messages: MessageRow[] = [
			asst({
				id: 'a1',
				meta: { firstTokenAt: 0, lastChunk: null, startedAt: 0, usage: { cost: 0.25, inputTokens: 0, outputTokens: 0 } },
			}),
			asst({
				id: 'a2',
				meta: { firstTokenAt: 0, lastChunk: null, startedAt: 0, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
			}),
		];
		// 0.25 (provider) + 1M * $3/M = $3.25
		const result = computeConversationCost(messages, lookup, 25);
		expect(result.llmCost).toBeCloseTo(3.25, 6);
		expect(result.total).toBeCloseTo(3.25, 6);
	});

	it('aggregates Kagi search cost across turns', () => {
		const parts: MessagePart[] = [
			{ id: 't', input: {}, name: 'web_search', type: 'tool_use' },
			{ id: 't2', input: {}, name: 'web_search', type: 'tool_use' },
		];
		const messages: MessageRow[] = [
			asst({ id: 'a1', meta: null, parts }),
			asst({ id: 'a2', meta: null, parts: [{ id: 't3', input: {}, name: 'web_search', type: 'tool_use' }] }),
		];
		// 3 searches * $25/1000 = $0.075
		const result = computeConversationCost(messages, lookup, 25);
		expect(result.webSearchCost).toBeCloseTo(0.075, 6);
		expect(result.llmCost).toBeNull();
		expect(result.total).toBeCloseTo(0.075, 6);
	});

	it('skips system messages and counts only assistant turns', () => {
		// `computeConversationCost` only sums turns with role==='assistant'.
		// Compaction injects role='system' summaries that carry no usage of
		// their own; this guards against them ever being billed.
		const messages: MessageRow[] = [
			asst({
				id: 'a1',
				meta: { firstTokenAt: 0, lastChunk: null, startedAt: 0, usage: { cost: 1, inputTokens: 0, outputTokens: 0 } },
			}),
			{
				content: 'Previous conversation summary: ...',
				createdAt: 0,
				error: null,
				id: 's1',
				meta: { firstTokenAt: 0, lastChunk: null, startedAt: 0, usage: { cost: 99, inputTokens: 99, outputTokens: 99 } },
				model: null,
				role: 'system',
				status: 'complete',
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
			asst({
				id: 'a1',
				meta: { firstTokenAt: 0, lastChunk: null, startedAt: 0, usage: { inputTokens: 100, outputTokens: 50 } },
				model: 'unknown/model',
			}),
			asst({ id: 'a2', meta: { firstTokenAt: 0, lastChunk: null, startedAt: 0, usage: { cost: 0.4, inputTokens: 0, outputTokens: 0 } } }),
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
			{ text: 'searching…', type: 'text' },
			{ id: '1', input: { query: 'a' }, name: 'web_search', type: 'tool_use' },
			{ id: '2', input: {}, name: 'fetch_url', type: 'tool_use' },
			{ id: '3', input: { query: 'b' }, name: 'web_search', type: 'tool_use' },
		];
		expect(countWebSearches(parts)).toBe(2);
	});

	it('respects extraNames', () => {
		const parts: MessagePart[] = [
			{ id: '1', input: {}, name: 'web_search', type: 'tool_use' },
			{ id: '2', input: {}, name: 'kagi_search', type: 'tool_use' },
		];
		expect(countWebSearches(parts, ['kagi_search'])).toBe(2);
	});

	it('does not double-count when a name appears in both the default set and extraNames', () => {
		const parts: MessagePart[] = [{ id: '1', input: {}, name: 'web_search', type: 'tool_use' }];
		// 'web_search' is built-in; passing it in extraNames again should not
		// matter (Set dedupe).
		expect(countWebSearches(parts, ['web_search'])).toBe(1);
	});

	it('ignores tool_result and text parts even when their text mentions web_search', () => {
		const parts: MessagePart[] = [
			{ text: 'I called web_search', type: 'text' },
			{ content: 'web_search results', isError: false, toolUseId: 't1', type: 'tool_result' },
		];
		expect(countWebSearches(parts)).toBe(0);
	});
});
