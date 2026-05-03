import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MODEL_LIST,
	parseModelList,
	serializeModelList,
	reasoningTypeFor,
} from './config';

describe('reasoningTypeFor', () => {
	it('detects effort models', () => {
		expect(reasoningTypeFor('openai/o3-mini')).toBe('effort');
		expect(reasoningTypeFor('openai/gpt-5.5')).toBe('effort');
		expect(reasoningTypeFor('x-ai/grok-3')).toBe('effort');
		expect(reasoningTypeFor('google/gemini-3.1-pro-preview')).toBe('effort');
	});
	it('detects max_tokens models', () => {
		expect(reasoningTypeFor('anthropic/claude-sonnet-4.6')).toBe('max_tokens');
		expect(reasoningTypeFor('claude-opus-4.7')).toBe('max_tokens');
		expect(reasoningTypeFor('moonshotai/kimi-k2.6')).toBe('max_tokens');
		expect(reasoningTypeFor('google/gemini-2.5-pro-preview-06-05')).toBe('max_tokens');
		expect(reasoningTypeFor('alibaba/qwen3.5')).toBe('max_tokens');
	});
	it('returns null for unknown models', () => {
		expect(reasoningTypeFor('mistral/mistral-large')).toBeNull();
		expect(reasoningTypeFor('foo/bar')).toBeNull();
	});
});

describe('parseModelList', () => {
	it('returns the defaults for null/empty input', () => {
		expect(parseModelList(null)).toEqual(DEFAULT_MODEL_LIST);
		expect(parseModelList('')).toEqual(DEFAULT_MODEL_LIST);
		expect(parseModelList('   \n  ')).toEqual(DEFAULT_MODEL_LIST);
	});
	it('parses JSON array with slug/label/reasoning', () => {
		const out = parseModelList(
			JSON.stringify([
				{ slug: 'foo/bar', label: 'Foo Bar' },
				{ slug: 'x/y', label: 'XY', reasoning: 'effort' },
			]),
		);
		expect(out).toEqual([
			{ slug: 'foo/bar', label: 'Foo Bar' },
			{ slug: 'x/y', label: 'XY', reasoning: 'effort' },
		]);
	});
	it('treats slug-only lines as label = slug', () => {
		expect(parseModelList(JSON.stringify([{ slug: 'foo/bar' }]))).toEqual([
			{ slug: 'foo/bar', label: 'foo/bar' },
		]);
	});
	it('ignores invalid reasoning values', () => {
		const out = parseModelList(
			JSON.stringify([{ slug: 'a', label: 'A', reasoning: 'bogus' }]),
		);
		expect(out).toEqual([{ slug: 'a', label: 'A' }]);
	});
	it('filters out entries with empty slug', () => {
		expect(parseModelList(JSON.stringify([{ slug: '', label: 'A' }]))).toEqual(DEFAULT_MODEL_LIST);
	});
	it('returns defaults for invalid JSON', () => {
		expect(parseModelList('not json')).toEqual(DEFAULT_MODEL_LIST);
	});
	it('returns defaults for non-array JSON', () => {
		expect(parseModelList('{"slug":"a"}')).toEqual(DEFAULT_MODEL_LIST);
	});
});

describe('serializeModelList', () => {
	it('round-trips with parseModelList for the defaults', () => {
		expect(parseModelList(serializeModelList(DEFAULT_MODEL_LIST))).toEqual(DEFAULT_MODEL_LIST);
	});
	it('serializes to pretty-printed JSON', () => {
		const out = serializeModelList([
			{ slug: 'a', label: 'A' },
			{ slug: 'b', label: 'B', reasoning: 'effort' },
		]);
		expect(out).toBe(
			JSON.stringify(
				[
					{ slug: 'a', label: 'A' },
					{ slug: 'b', label: 'B', reasoning: 'effort' },
				],
				null,
				2,
			),
		);
	});
});
