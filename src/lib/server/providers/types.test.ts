import { describe, expect, it } from 'vitest';
import { buildGlobalModelId, parseGlobalModelId } from './types';

describe('buildGlobalModelId', () => {
	it('joins providerId and modelId with a single slash', () => {
		expect(buildGlobalModelId('openrouter', 'anthropic/claude')).toBe('openrouter/anthropic/claude');
		expect(buildGlobalModelId('a', 'b')).toBe('a/b');
	});
	it('does not collapse leading/trailing slashes from inputs', () => {
		// The id pieces are passed verbatim — callers are expected to pass
		// well-formed ids; we just want to lock the join behaviour down.
		expect(buildGlobalModelId('a', '/b')).toBe('a//b');
		expect(buildGlobalModelId('a/', 'b')).toBe('a//b');
	});
});

describe('parseGlobalModelId', () => {
	it('splits on the first slash', () => {
		expect(parseGlobalModelId('openrouter/anthropic/claude')).toEqual({
			modelId: 'anthropic/claude',
			providerId: 'openrouter',
		});
	});
	it('handles a single-slash id (provider/model)', () => {
		expect(parseGlobalModelId('p/m')).toEqual({ modelId: 'm', providerId: 'p' });
	});
	it('preserves an empty model segment when input ends in a slash', () => {
		expect(parseGlobalModelId('p/')).toEqual({ modelId: '', providerId: 'p' });
	});
	it('treats a leading slash as an empty providerId', () => {
		expect(parseGlobalModelId('/m')).toEqual({ modelId: 'm', providerId: '' });
	});
	it('throws on inputs without a slash', () => {
		expect(() => parseGlobalModelId('justmodel')).toThrow(/Invalid global model ID/);
		expect(() => parseGlobalModelId('')).toThrow(/Invalid global model ID/);
	});
	it('round-trips through buildGlobalModelId for typical ids', () => {
		const ids = ['p/m', 'openrouter/anthropic/claude-haiku', 'workers-ai/@cf/meta/llama'];
		for (const id of ids) {
			const { providerId, modelId } = parseGlobalModelId(id);
			expect(buildGlobalModelId(providerId, modelId)).toBe(id);
		}
	});
});
