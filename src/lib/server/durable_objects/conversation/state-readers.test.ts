import { describe, expect, it } from 'vitest';
import { deriveMeta } from './state-readers';

describe('deriveMeta', () => {
	it('returns null when none of the meta columns are populated', () => {
		expect(deriveMeta(null, null, null, null)).toBeNull();
	});

	it('zero-fills timestamps when only chunk/usage are present', () => {
		const meta = deriveMeta(null, null, '{"x":1}', '{"inputTokens":10,"outputTokens":20}');
		expect(meta).not.toBeNull();
		expect(meta?.startedAt).toBe(0);
		expect(meta?.firstTokenAt).toBe(0);
		expect(meta?.lastChunk).toEqual({ x: 1 });
		expect(meta?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
	});

	it('keeps lastChunk null when JSON is malformed (does not throw)', () => {
		const meta = deriveMeta(100, 150, '{not json', null);
		expect(meta?.lastChunk).toBeNull();
		expect(meta?.usage).toBeNull();
		expect(meta?.startedAt).toBe(100);
		expect(meta?.firstTokenAt).toBe(150);
	});

	it('keeps usage null when usage JSON is malformed', () => {
		const meta = deriveMeta(100, 150, null, '{also bad');
		expect(meta?.usage).toBeNull();
	});

	it('passes through fully populated rows', () => {
		const meta = deriveMeta(1000, 1200, '{"finishReason":"stop"}', '{"inputTokens":5,"outputTokens":7,"cost":0.001}');
		expect(meta).toEqual({
			firstTokenAt: 1200,
			lastChunk: { finishReason: 'stop' },
			startedAt: 1000,
			usage: { cost: 0.001, inputTokens: 5, outputTokens: 7 },
		});
	});
});
