import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import * as remote from './providers.remote';
import { createProvider, getProvider, listProviders } from './server/providers/store';
import {
	createModel,
	getModel,
	listAllModels,
	listModelsForProvider,
} from './server/providers/models';

type AnyArgs = (...args: unknown[]) => Promise<unknown>;
const saveProvider = remote.saveProvider as unknown as AnyArgs;
const deleteProviderAction = remote.deleteProviderAction as unknown as AnyArgs;
const saveProviderModel = remote.saveProviderModel as unknown as AnyArgs;
const deleteProviderModel = remote.deleteProviderModel as unknown as AnyArgs;
const reorderProviderModel = remote.reorderProviderModel as unknown as AnyArgs;
const addPresetProvider = remote.addPresetProvider as unknown as AnyArgs;
const fetchPresetModels = remote.fetchPresetModels as unknown as AnyArgs;

beforeEach(() => {
	setMockRequestEvent({ platform: { env } });
});

afterEach(async () => {
	clearMockRequestEvent();
	vi.restoreAllMocks();
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
});

async function expectRedirect(promise: Promise<unknown>, locationStartsWith: string) {
	try {
		await promise;
		throw new Error('expected redirect');
	} catch (e) {
		if (!isRedirect(e)) throw e;
		expect(e.location.startsWith(locationStartsWith)).toBe(true);
	}
}

async function expectError(promise: Promise<unknown>, status: number, msg?: RegExp) {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
		if (msg) expect(String(e.body.message)).toMatch(msg);
	}
}

async function runForm(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch (e) {
		if (!isRedirect(e)) throw e;
	}
}

describe('providers.remote — saveProvider', () => {
	it('creates a new provider with valid id and type', async () => {
		await expectRedirect(
			saveProvider({
				id: 'my-anthropic',
				type: 'anthropic',
				api_key: 'sk-test',
				endpoint: '',
				gateway_id: '',
			}) as Promise<unknown>,
			'/settings',
		);
		const row = await getProvider(env, 'my-anthropic');
		expect(row).toMatchObject({ id: 'my-anthropic', type: 'anthropic', apiKey: 'sk-test' });
	});

	it('updates an existing provider in place (does not change type)', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic', apiKey: 'old' });
		await expectRedirect(
			saveProvider({
				id: 'p1',
				type: 'anthropic',
				api_key: 'new',
				endpoint: 'https://example.com',
				gateway_id: '',
			}) as Promise<unknown>,
			'/settings',
		);
		const row = await getProvider(env, 'p1');
		expect(row?.apiKey).toBe('new');
		expect(row?.endpoint).toBe('https://example.com');
	});

	it('rejects malformed provider ids', async () => {
		await expectError(
			saveProvider({ id: '1bad', type: 'anthropic' }) as Promise<unknown>,
			400,
			/Provider ID/,
		);
		await expectError(
			saveProvider({ id: 'Bad-Caps', type: 'anthropic' }) as Promise<unknown>,
			400,
		);
		await expectError(saveProvider({ id: '', type: 'anthropic' }) as Promise<unknown>, 400);
	});

	it('rejects an invalid provider type', async () => {
		await expectError(
			saveProvider({ id: 'p1', type: 'cohere' }) as Promise<unknown>,
			400,
			/Invalid provider type/,
		);
	});
});

describe('providers.remote — deleteProviderAction', () => {
	it('removes the row', async () => {
		await createProvider(env, { id: 'gone', type: 'anthropic' });
		await expectRedirect(deleteProviderAction({ id: 'gone' }) as Promise<unknown>, '/settings');
		expect(await getProvider(env, 'gone')).toBeNull();
	});

	it('rejects an empty id', async () => {
		await expectError(deleteProviderAction({ id: '' }) as Promise<unknown>, 400);
	});
});

describe('providers.remote — saveProviderModel', () => {
	it('creates a model with parsed costs and reasoning_type', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await expectRedirect(
			saveProviderModel({
				provider_id: 'p1',
				model_id: 'm1',
				name: 'Model 1',
				description: 'desc',
				max_context_length: '200000',
				reasoning_type: 'max_tokens',
				input_cost_per_million_tokens: '3.5',
				output_cost_per_million_tokens: '15',
			}) as Promise<unknown>,
			'/settings',
		);
		const row = await getModel(env, 'p1', 'm1');
		expect(row).toMatchObject({
			id: 'm1',
			providerId: 'p1',
			name: 'Model 1',
			description: 'desc',
			maxContextLength: 200000,
			reasoningType: 'max_tokens',
			inputCostPerMillionTokens: 3.5,
			outputCostPerMillionTokens: 15,
		});
	});

	it('updates an existing model when (provider_id, model_id) matches', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'm1', name: 'old name' });
		await runForm(
			saveProviderModel({
				provider_id: 'p1',
				model_id: 'm1',
				name: 'new name',
				max_context_length: '128000',
				reasoning_type: '',
			}),
		);
		const row = await getModel(env, 'p1', 'm1');
		expect(row?.name).toBe('new name');
		expect(row?.reasoningType).toBeNull();
	});

	it('defaults max_context_length to 128000 when blank', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await runForm(
			saveProviderModel({
				provider_id: 'p1',
				model_id: 'm1',
				name: 'm',
				max_context_length: '',
			}),
		);
		const row = await getModel(env, 'p1', 'm1');
		expect(row?.maxContextLength).toBe(128_000);
	});

	it('rejects negative input_cost', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await expectError(
			saveProviderModel({
				provider_id: 'p1',
				model_id: 'm1',
				name: 'm',
				input_cost_per_million_tokens: '-1',
			}) as Promise<unknown>,
			400,
			/non-negative/,
		);
	});

	it('rejects an invalid reasoning_type', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await expectError(
			saveProviderModel({
				provider_id: 'p1',
				model_id: 'm1',
				name: 'm',
				reasoning_type: 'bogus',
			}) as Promise<unknown>,
			400,
			/reasoning type/,
		);
	});

	it('requires non-empty name / provider_id / model_id', async () => {
		await expectError(
			saveProviderModel({ provider_id: '', model_id: 'm', name: 'n' }) as Promise<unknown>,
			400,
		);
		await expectError(
			saveProviderModel({ provider_id: 'p', model_id: '', name: 'n' }) as Promise<unknown>,
			400,
		);
		await expectError(
			saveProviderModel({ provider_id: 'p', model_id: 'm', name: '' }) as Promise<unknown>,
			400,
		);
	});
});

describe('providers.remote — deleteProviderModel', () => {
	it('removes the row', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'm1', name: 'm' });
		await expectRedirect(
			deleteProviderModel({ provider_id: 'p1', model_id: 'm1' }) as Promise<unknown>,
			'/settings',
		);
		expect(await getModel(env, 'p1', 'm1')).toBeNull();
	});
});

describe('providers.remote — reorderProviderModel', () => {
	it('swaps adjacent models when moving down', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 0 });
		await createModel(env, 'p1', { id: 'b', name: 'B', sortOrder: 10 });
		await createModel(env, 'p1', { id: 'c', name: 'C', sortOrder: 20 });
		await expectRedirect(
			reorderProviderModel({ provider_id: 'p1', model_id: 'a', direction: 'down' }) as Promise<unknown>,
			'/settings',
		);
		const list = await listModelsForProvider(env, 'p1');
		expect(list.map((m) => m.id)).toEqual(['b', 'a', 'c']);
	});

	it('is a no-op at the boundary', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 0 });
		await createModel(env, 'p1', { id: 'b', name: 'B', sortOrder: 10 });
		await expectRedirect(
			reorderProviderModel({ provider_id: 'p1', model_id: 'a', direction: 'up' }) as Promise<unknown>,
			'/settings',
		);
		const list = await listModelsForProvider(env, 'p1');
		expect(list.map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('rejects an unknown model', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await expectError(
			reorderProviderModel({ provider_id: 'p1', model_id: 'missing', direction: 'down' }) as Promise<unknown>,
			400,
			/not found/,
		);
	});

	it('rejects an invalid direction', async () => {
		await expectError(
			reorderProviderModel({ provider_id: 'p1', model_id: 'a', direction: 'sideways' }) as Promise<unknown>,
			400,
		);
	});
});

describe('providers.remote — addPresetProvider', () => {
	it('creates the provider plus all of the preset\'s default models', async () => {
		// `ai-gateway` has 8 default models (see providers/presets.ts).
		await expectRedirect(
			addPresetProvider({
				id: 'ai-gateway',
				provider_id: 'cf-gateway',
				api_key: 'k',
			}) as Promise<unknown>,
			'/settings',
		);
		const provider = await getProvider(env, 'cf-gateway');
		expect(provider?.type).toBe('openai_compatible');
		const models = await listAllModels(env);
		expect(models.length).toBeGreaterThanOrEqual(8);
		// Sort orders should leave gaps so the user can insert future models.
		expect(models[0].sortOrder).toBe(0);
		expect(models[1].sortOrder).toBe(10);
	});

	it('respects an explicit model_ids subset', async () => {
		await expectRedirect(
			addPresetProvider({
				id: 'ai-gateway',
				provider_id: 'cf2',
				api_key: 'k',
				model_ids: 'openai/gpt-5.5,anthropic/claude-sonnet-4-6',
			}) as Promise<unknown>,
			'/settings',
		);
		const models = await listModelsForProvider(env, 'cf2');
		expect(models.map((m) => m.id).sort()).toEqual(
			['anthropic/claude-sonnet-4-6', 'openai/gpt-5.5'].sort(),
		);
	});

	it('falls back to preset.defaultEndpoint when endpoint is blank', async () => {
		await runForm(
			addPresetProvider({
				id: 'ai-gateway',
				provider_id: 'cf3',
				api_key: 'k',
				endpoint: '',
			}),
		);
		const provider = await getProvider(env, 'cf3');
		expect(provider?.endpoint).toContain('gateway.ai.cloudflare.com');
	});

	it('rejects an unknown preset', async () => {
		await expectError(
			addPresetProvider({ id: 'mystery', provider_id: 'p', api_key: 'k' }) as Promise<unknown>,
			400,
			/preset/,
		);
	});

	it('rejects a duplicate provider id with 400 instead of 500', async () => {
		await createProvider(env, { id: 'taken', type: 'openai_compatible' });
		await expectError(
			addPresetProvider({ id: 'ai-gateway', provider_id: 'taken' }) as Promise<unknown>,
			400,
			/already exists/,
		);
	});
});

describe('providers.remote — fetchPresetModels', () => {
	it('returns models from the mocked OpenRouter /api/v1/models response', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					data: [
						{ id: 'anthropic/claude-sonnet-4-6', name: 'Claude', context_length: 200_000 },
						{ id: 'openai/gpt-5.5', name: 'GPT-5.5', context_length: 1_000_000 },
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		);
		const models = (await fetchPresetModels({ preset_id: 'openrouter' })) as Array<{
			id: string;
			name: string;
			maxContextLength: number;
		}>;
		expect(models.map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4-6', 'openai/gpt-5.5']);
		expect(models[0].maxContextLength).toBe(200_000);
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(String(fetchSpy.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/models');
	});

	it('forwards the apiKey as a Bearer token when provided', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ data: [] }), { status: 200 }),
		);
		await fetchPresetModels({ preset_id: 'openrouter', api_key: 'sk-or' });
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sk-or');
	});

	it('rejects an unknown preset', async () => {
		await expectError(fetchPresetModels({ preset_id: 'mystery' }) as Promise<unknown>, 400, /preset/);
	});

	it('rejects a preset that does not support model fetching', async () => {
		await expectError(
			fetchPresetModels({ preset_id: 'workers-ai' }) as Promise<unknown>,
			400,
			/does not support/,
		);
	});

	it('rejects an empty preset id', async () => {
		await expectError(fetchPresetModels({ preset_id: '' }) as Promise<unknown>, 400);
	});
});
