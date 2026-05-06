import { describe, expect, it } from 'vitest';
import { computeCost, countWebSearches } from './cost';
import type { MessagePart } from '$lib/types/conversation';

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
});
