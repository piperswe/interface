import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import * as remote from './providers.remote';
import { createModel, getModel, listAllModels, listModelsForProvider } from './server/providers/models';
import { createProvider, getProvider } from './server/providers/store';

type AnyArgs = (...args: unknown[]) => Promise<unknown>;
const saveProvider = remote.saveProvider as unknown as AnyArgs;
const deleteProviderAction = remote.deleteProviderAction as unknown as AnyArgs;
const saveProviderModel = remote.saveProviderModel as unknown as AnyArgs;
const deleteProviderModel = remote.deleteProviderModel as unknown as AnyArgs;
const reorderProviderModel = remote.reorderProviderModel as unknown as AnyArgs;
const addPresetProvider = remote.addPresetProvider as unknown as AnyArgs;
const fetchPresetModels = remote.fetchPresetModels as unknown as AnyArgs;
const importModelsFromDev = remote.importModelsFromDev as unknown as AnyArgs;

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
				api_key: 'sk-test',
				endpoint: '',
				gateway_id: '',
				id: 'my-anthropic',
				type: 'anthropic',
			}) as Promise<unknown>,
			'/settings',
		);
		const row = await getProvider(env, 'my-anthropic');
		expect(row).toMatchObject({ apiKey: 'sk-test', id: 'my-anthropic', type: 'anthropic' });
	});

	it('updates an existing provider in place (does not change type)', async () => {
		await createProvider(env, { apiKey: 'old', id: 'p1', type: 'anthropic' });
		await expectRedirect(
			saveProvider({
				api_key: 'new',
				endpoint: 'https://example.com',
				gateway_id: '',
				id: 'p1',
				type: 'anthropic',
			}) as Promise<unknown>,
			'/settings',
		);
		const row = await getProvider(env, 'p1');
		expect(row?.apiKey).toBe('new');
		expect(row?.endpoint).toBe('https://example.com');
	});

	it('rejects malformed provider ids', async () => {
		await expectError(saveProvider({ id: '1bad', type: 'anthropic' }) as Promise<unknown>, 400, /Provider ID/);
		await expectError(saveProvider({ id: 'Bad-Caps', type: 'anthropic' }) as Promise<unknown>, 400);
		await expectError(saveProvider({ id: '', type: 'anthropic' }) as Promise<unknown>, 400);
	});

	it('rejects an invalid provider type', async () => {
		await expectError(saveProvider({ id: 'p1', type: 'cohere' }) as Promise<unknown>, 400, /Invalid provider type/);
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
				description: 'desc',
				input_cost_per_million_tokens: '3.5',
				max_context_length: '200000',
				model_id: 'm1',
				name: 'Model 1',
				output_cost_per_million_tokens: '15',
				provider_id: 'p1',
				reasoning_type: 'max_tokens',
			}) as Promise<unknown>,
			'/settings',
		);
		const row = await getModel(env, 'p1', 'm1');
		expect(row).toMatchObject({
			description: 'desc',
			id: 'm1',
			inputCostPerMillionTokens: 3.5,
			maxContextLength: 200000,
			name: 'Model 1',
			outputCostPerMillionTokens: 15,
			providerId: 'p1',
			reasoningType: 'max_tokens',
		});
	});

	it('updates an existing model when (provider_id, model_id) matches', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'm1', name: 'old name' });
		await runForm(
			saveProviderModel({
				max_context_length: '128000',
				model_id: 'm1',
				name: 'new name',
				provider_id: 'p1',
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
				max_context_length: '',
				model_id: 'm1',
				name: 'm',
				provider_id: 'p1',
			}),
		);
		const row = await getModel(env, 'p1', 'm1');
		expect(row?.maxContextLength).toBe(128_000);
	});

	it('rejects negative input_cost', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await expectError(
			saveProviderModel({
				input_cost_per_million_tokens: '-1',
				model_id: 'm1',
				name: 'm',
				provider_id: 'p1',
			}) as Promise<unknown>,
			400,
			/non-negative/,
		);
	});

	it('rejects an invalid reasoning_type', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await expectError(
			saveProviderModel({
				model_id: 'm1',
				name: 'm',
				provider_id: 'p1',
				reasoning_type: 'bogus',
			}) as Promise<unknown>,
			400,
			/reasoning type/,
		);
	});

	it('requires non-empty name / provider_id / model_id', async () => {
		await expectError(saveProviderModel({ model_id: 'm', name: 'n', provider_id: '' }) as Promise<unknown>, 400);
		await expectError(saveProviderModel({ model_id: '', name: 'n', provider_id: 'p' }) as Promise<unknown>, 400);
		await expectError(saveProviderModel({ model_id: 'm', name: '', provider_id: 'p' }) as Promise<unknown>, 400);
	});

	it('round-trips supports_image_input through create + update', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await runForm(
			saveProviderModel({
				model_id: 'm1',
				name: 'vision-capable',
				provider_id: 'p1',
				supports_image_input: 'on',
			}),
		);
		expect((await getModel(env, 'p1', 'm1'))?.supportsImageInput).toBe(true);
		// Updating without the checkbox in the form data clears it (HTML
		// checkboxes omit the field when unchecked).
		await runForm(
			saveProviderModel({
				model_id: 'm1',
				name: 'vision-capable',
				provider_id: 'p1',
			}),
		);
		expect((await getModel(env, 'p1', 'm1'))?.supportsImageInput).toBe(false);
	});
});

describe('providers.remote — deleteProviderModel', () => {
	it('removes the row', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'm1', name: 'm' });
		await expectRedirect(deleteProviderModel({ model_id: 'm1', provider_id: 'p1' }) as Promise<unknown>, '/settings');
		expect(await getModel(env, 'p1', 'm1')).toBeNull();
	});
});

describe('providers.remote — reorderProviderModel', () => {
	it('swaps adjacent models when moving down', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 0 });
		await createModel(env, 'p1', { id: 'b', name: 'B', sortOrder: 10 });
		await createModel(env, 'p1', { id: 'c', name: 'C', sortOrder: 20 });
		await expectRedirect(reorderProviderModel({ direction: 'down', model_id: 'a', provider_id: 'p1' }) as Promise<unknown>, '/settings');
		const list = await listModelsForProvider(env, 'p1');
		expect(list.map((m) => m.id)).toEqual(['b', 'a', 'c']);
	});

	it('is a no-op at the boundary', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 0 });
		await createModel(env, 'p1', { id: 'b', name: 'B', sortOrder: 10 });
		await expectRedirect(reorderProviderModel({ direction: 'up', model_id: 'a', provider_id: 'p1' }) as Promise<unknown>, '/settings');
		const list = await listModelsForProvider(env, 'p1');
		expect(list.map((m) => m.id)).toEqual(['a', 'b']);
	});

	it('rejects an unknown model', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await expectError(
			reorderProviderModel({ direction: 'down', model_id: 'missing', provider_id: 'p1' }) as Promise<unknown>,
			400,
			/not found/,
		);
	});

	it('rejects an invalid direction', async () => {
		await expectError(reorderProviderModel({ direction: 'sideways', model_id: 'a', provider_id: 'p1' }) as Promise<unknown>, 400);
	});
});

describe('providers.remote — addPresetProvider', () => {
	it("creates the provider plus all of the preset's default models", async () => {
		// `ai-gateway` has 8 default models (see providers/presets.ts).
		await expectRedirect(
			addPresetProvider({
				api_key: 'k',
				id: 'ai-gateway',
				provider_id: 'cf-gateway',
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
				api_key: 'k',
				id: 'ai-gateway',
				model_ids: 'openai/gpt-5.5,anthropic/claude-sonnet-4-6',
				provider_id: 'cf2',
			}) as Promise<unknown>,
			'/settings',
		);
		const models = await listModelsForProvider(env, 'cf2');
		expect(models.map((m) => m.id).sort()).toEqual(['anthropic/claude-sonnet-4-6', 'openai/gpt-5.5'].sort());
	});

	it('falls back to preset.defaultEndpoint when endpoint is blank', async () => {
		await runForm(
			addPresetProvider({
				api_key: 'k',
				endpoint: '',
				id: 'ai-gateway',
				provider_id: 'cf3',
			}),
		);
		const provider = await getProvider(env, 'cf3');
		expect(provider?.endpoint).toContain('gateway.ai.cloudflare.com');
	});

	it('rejects an unknown preset', async () => {
		await expectError(addPresetProvider({ api_key: 'k', id: 'mystery', provider_id: 'p' }) as Promise<unknown>, 400, /preset/);
	});

	it('rejects a duplicate provider id with 400 instead of 500', async () => {
		await createProvider(env, { id: 'taken', type: 'openai_compatible' });
		await expectError(addPresetProvider({ id: 'ai-gateway', provider_id: 'taken' }) as Promise<unknown>, 400, /already exists/);
	});
});

describe('providers.remote — fetchPresetModels', () => {
	it('returns models from the mocked OpenRouter /api/v1/models response', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					data: [
						{ context_length: 200_000, id: 'anthropic/claude-sonnet-4-6', name: 'Claude' },
						{ context_length: 1_000_000, id: 'openai/gpt-5.5', name: 'GPT-5.5' },
					],
				}),
				{ headers: { 'content-type': 'application/json' }, status: 200 },
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
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
		await fetchPresetModels({ api_key: 'sk-or', preset_id: 'openrouter' });
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer sk-or');
	});

	it('rejects an unknown preset', async () => {
		await expectError(fetchPresetModels({ preset_id: 'mystery' }) as Promise<unknown>, 400, /preset/);
	});

	it('rejects a preset that does not support model fetching', async () => {
		await expectError(fetchPresetModels({ preset_id: 'workers-ai' }) as Promise<unknown>, 400, /does not support/);
	});

	it('rejects an empty preset id', async () => {
		await expectError(fetchPresetModels({ preset_id: '' }) as Promise<unknown>, 400);
	});
});

describe('providers.remote — importModelsFromDev', () => {
	function mockModelsDevOnce(body: unknown) {
		return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
	}

	const ANTHROPIC_CATALOG = {
		anthropic: {
			models: {
				'claude-opus-4-6': {
					attachment: true,
					cost: { input: 3, output: 15 },
					id: 'claude-opus-4-6',
					limit: { context: 200_000, output: 64_000 },
					modalities: { input: ['text', 'image'], output: ['text'] },
					name: 'Claude Opus 4',
					open_weights: false,
					reasoning: true,
					release_date: '2025-05-22',
					tool_call: true,
				},
				'claude-sonnet-4-6': {
					attachment: true,
					cost: { input: 3, output: 15 },
					id: 'claude-sonnet-4-6',
					limit: { context: 200_000, output: 64_000 },
					modalities: { input: ['text', 'image'], output: ['text'] },
					name: 'Claude Sonnet 4',
					open_weights: false,
					reasoning: true,
					release_date: '2025-05-22',
					tool_call: true,
				},
			},
			name: 'Anthropic',
		},
	};

	it('imports a selected model into an existing provider with metadata prefilled', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		mockModelsDevOnce(ANTHROPIC_CATALOG);
		await expectRedirect(
			importModelsFromDev({
				id_prefix: '',
				model_keys: 'anthropic:claude-opus-4-6',
				provider_id: 'p1',
			}) as Promise<unknown>,
			'/settings',
		);
		const m = await getModel(env, 'p1', 'claude-opus-4-6');
		expect(m?.name).toBe('Claude Opus 4');
		expect(m?.maxContextLength).toBe(200_000);
		expect(m?.reasoningType).toBe('max_tokens');
		expect(m?.supportsImageInput).toBe(true);
		expect(m?.inputCostPerMillionTokens).toBe(3);
		expect(m?.outputCostPerMillionTokens).toBe(15);
	});

	it('honors id_prefix when constructing the imported model id', async () => {
		await createProvider(env, { endpoint: 'https://x.example/v1', id: 'or', type: 'openai_compatible' });
		mockModelsDevOnce(ANTHROPIC_CATALOG);
		await expectRedirect(
			importModelsFromDev({
				id_prefix: 'anthropic/',
				model_keys: 'anthropic:claude-opus-4-6',
				provider_id: 'or',
			}) as Promise<unknown>,
			'/settings',
		);
		expect(await getModel(env, 'or', 'anthropic/claude-opus-4-6')).not.toBeNull();
	});

	// Regression: id_prefix came in from a text input untrimmed, so a user
	// accidentally typing " anthropic/" persisted a model id with a leading
	// space and broke inference calls. providerId and model_keys already
	// trim; id_prefix must too.
	it('trims whitespace from id_prefix before constructing the model id', async () => {
		await createProvider(env, { endpoint: 'https://x.example/v1', id: 'or', type: 'openai_compatible' });
		mockModelsDevOnce(ANTHROPIC_CATALOG);
		await expectRedirect(
			importModelsFromDev({
				id_prefix: '  anthropic/  ',
				model_keys: 'anthropic:claude-opus-4-6',
				provider_id: 'or',
			}) as Promise<unknown>,
			'/settings',
		);
		expect(await getModel(env, 'or', 'anthropic/claude-opus-4-6')).not.toBeNull();
		expect(await getModel(env, 'or', '  anthropic/  claude-opus-4-6')).toBeNull();
	});

	it('skips models that already exist instead of erroring on the unique constraint', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'claude-opus-4-6', name: 'preexisting', sortOrder: 0 });
		mockModelsDevOnce(ANTHROPIC_CATALOG);
		await expectRedirect(
			importModelsFromDev({
				id_prefix: '',
				model_keys: 'anthropic:claude-opus-4-6,anthropic:claude-sonnet-4-6',
				provider_id: 'p1',
			}) as Promise<unknown>,
			'/settings',
		);
		// existing row left untouched
		expect((await getModel(env, 'p1', 'claude-opus-4-6'))?.name).toBe('preexisting');
		// new row appended
		expect(await getModel(env, 'p1', 'claude-sonnet-4-6')).not.toBeNull();
	});

	// Regression: imported models used to inherit sortOrder = existing.length * 10,
	// which interleaves with existing rows when sort orders have gaps (left behind
	// by a delete or reorder). The baseSort must derive from the actual max.
	it('appends imported models after the current max sortOrder even when gaps exist', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		// Three models with gappy sort orders, e.g. after deleting rows at 10 and 30.
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 0 });
		await createModel(env, 'p1', { id: 'b', name: 'B', sortOrder: 20 });
		await createModel(env, 'p1', { id: 'c', name: 'C', sortOrder: 40 });
		mockModelsDevOnce(ANTHROPIC_CATALOG);
		await expectRedirect(
			importModelsFromDev({
				id_prefix: '',
				model_keys: 'anthropic:claude-opus-4-6',
				provider_id: 'p1',
			}) as Promise<unknown>,
			'/settings',
		);
		const imported = await getModel(env, 'p1', 'claude-opus-4-6');
		expect(imported?.sortOrder).toBeGreaterThan(40);
	});

	it('rejects when provider does not exist', async () => {
		mockModelsDevOnce(ANTHROPIC_CATALOG);
		await expectError(
			importModelsFromDev({
				model_keys: 'anthropic:claude-opus-4-6',
				provider_id: 'missing',
			}) as Promise<unknown>,
			400,
			/not found/,
		);
	});

	it('rejects when no model_keys are provided', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await expectError(importModelsFromDev({ model_keys: '', provider_id: 'p1' }) as Promise<unknown>, 400, /at least one/);
	});
});
