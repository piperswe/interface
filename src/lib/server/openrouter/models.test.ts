import { env } from 'cloudflare:test';
import { OpenRouter } from '@openrouter/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _clearModelsCache, getModelContextWindow } from './models';

afterEach(() => {
	_clearModelsCache();
	vi.restoreAllMocks();
});

function mockModelsList(models: Array<{ id: string; contextLength?: number | null; topProvider?: { contextLength?: number | null } | null }>) {
	vi.spyOn(OpenRouter.prototype.models, 'list').mockResolvedValue({ data: models } as never);
}

describe('getModelContextWindow', () => {
	it('returns the fallback when the catalog fetch fails', async () => {
		vi.spyOn(OpenRouter.prototype.models, 'list').mockRejectedValue(new Error('boom'));
		expect(await getModelContextWindow(env, 'unknown/model')).toBe(128_000);
	});
	it('returns the fallback when the model is not found in the catalog', async () => {
		mockModelsList([{ id: 'foo/bar', contextLength: 32_000 }]);
		expect(await getModelContextWindow(env, 'unknown/model')).toBe(128_000);
	});
	it('returns the model-level context length when present', async () => {
		mockModelsList([{ id: 'foo/bar', contextLength: 200_000, topProvider: { contextLength: 50_000 } }]);
		expect(await getModelContextWindow(env, 'foo/bar')).toBe(200_000);
	});
	it('falls back to the provider-level context length when model-level is missing', async () => {
		mockModelsList([{ id: 'foo/bar', contextLength: null, topProvider: { contextLength: 50_000 } }]);
		expect(await getModelContextWindow(env, 'foo/bar')).toBe(50_000);
	});
	it('returns the global fallback when both context lengths are null', async () => {
		mockModelsList([{ id: 'foo/bar', contextLength: null, topProvider: null }]);
		expect(await getModelContextWindow(env, 'foo/bar')).toBe(128_000);
	});
	it('normalises bare anthropic ids to vendor-prefixed lookup keys', async () => {
		mockModelsList([{ id: 'anthropic/claude-sonnet-4-5', contextLength: 1_000_000 }]);
		expect(await getModelContextWindow(env, 'claude-sonnet-4-5')).toBe(1_000_000);
	});
	it('caches the catalog across calls (only one fetch)', async () => {
		const spy = vi.spyOn(OpenRouter.prototype.models, 'list').mockResolvedValue({
			data: [{ id: 'foo/bar', contextLength: 100 }],
		} as never);
		await getModelContextWindow(env, 'foo/bar');
		await getModelContextWindow(env, 'foo/bar');
		await getModelContextWindow(env, 'foo/bar');
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
