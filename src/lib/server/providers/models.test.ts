import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createModel,
	deleteModel,
	deleteModelsForProvider,
	getModel,
	getResolvedModel,
	listAllGlobalModelIds,
	listAllModels,
	listGlobalIdsForProvider,
	listModelsForProvider,
	moveModelToPosition,
	swapModelOrder,
	updateModel,
} from './models';
import { createProvider } from './store';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
});

async function setupProvider(id = 'p1') {
	await createProvider(env, { id, type: 'openai_compatible', apiKey: 'sk', endpoint: 'https://x/v1' });
}

describe('createModel + getModel', () => {
	it('round-trips a model with explicit fields', async () => {
		await setupProvider();
		await createModel(env, 'p1', {
			id: 'gpt-x',
			name: 'GPT X',
			description: 'flagship',
			maxContextLength: 200_000,
			reasoningType: 'effort',
			inputCostPerMillionTokens: 3,
			outputCostPerMillionTokens: 15,
			sortOrder: 5,
		});
		const m = await getModel(env, 'p1', 'gpt-x');
		expect(m).toMatchObject({
			id: 'gpt-x',
			providerId: 'p1',
			name: 'GPT X',
			description: 'flagship',
			maxContextLength: 200_000,
			reasoningType: 'effort',
			inputCostPerMillionTokens: 3,
			outputCostPerMillionTokens: 15,
			sortOrder: 5,
		});
		expect(m?.createdAt).toBeGreaterThan(0);
		expect(m?.updatedAt).toBe(m?.createdAt);
	});

	it('applies sane defaults for omitted fields', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'a', name: 'A' });
		const m = await getModel(env, 'p1', 'a');
		expect(m).toMatchObject({
			description: null,
			maxContextLength: 128_000, // default
			reasoningType: null,
			inputCostPerMillionTokens: null,
			outputCostPerMillionTokens: null,
			sortOrder: 0,
		});
	});

	it('getModel returns null for unknown ids', async () => {
		await setupProvider();
		expect(await getModel(env, 'p1', 'nope')).toBeNull();
		expect(await getModel(env, 'no-provider', 'a')).toBeNull();
	});

	it('isolates list queries per user_id when each user has their own provider row', async () => {
		// providers.id is a global PRIMARY KEY, so two users can't share an id
		// in the same database; the user_id filter still scopes reads.
		await createProvider(env, { id: 'p-u1', type: 'anthropic' }, 1);
		await createProvider(env, { id: 'p-u2', type: 'anthropic' }, 2);
		await createModel(env, 'p-u1', { id: 'a', name: 'A' }, 1);
		await createModel(env, 'p-u2', { id: 'b', name: 'B' }, 2);
		expect((await listModelsForProvider(env, 'p-u1', 1)).map((m) => m.id)).toEqual(['a']);
		expect((await listModelsForProvider(env, 'p-u2', 2)).map((m) => m.id)).toEqual(['b']);
		// Wrong user → no rows.
		expect(await listModelsForProvider(env, 'p-u1', 2)).toEqual([]);
	});
});

describe('listModelsForProvider + listAllModels', () => {
	it('orders by sort_order ASC, then name ASC', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'x', name: 'X', sortOrder: 2 });
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 1 });
		await createModel(env, 'p1', { id: 'm', name: 'M', sortOrder: 1 });
		const rows = await listModelsForProvider(env, 'p1');
		expect(rows.map((r) => r.id)).toEqual(['a', 'm', 'x']);
	});

	it('listAllModels groups by provider_id, then sort_order, then name', async () => {
		await createProvider(env, { id: 'beta', type: 'anthropic' });
		await createProvider(env, { id: 'alpha', type: 'anthropic' });
		await createModel(env, 'beta', { id: 'b1', name: 'B1' });
		await createModel(env, 'alpha', { id: 'a2', name: 'A2', sortOrder: 5 });
		await createModel(env, 'alpha', { id: 'a1', name: 'A1', sortOrder: 1 });
		const rows = await listAllModels(env);
		expect(rows.map((r) => `${r.providerId}/${r.id}`)).toEqual([
			'alpha/a1',
			'alpha/a2',
			'beta/b1',
		]);
	});
});

describe('listGlobalIdsForProvider + listAllGlobalModelIds', () => {
	it('returns globally-qualified ids', async () => {
		await setupProvider();
		await createProvider(env, { id: 'p2', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'a', name: 'A' });
		await createModel(env, 'p1', { id: 'b', name: 'B' });
		await createModel(env, 'p2', { id: 'x', name: 'X' });
		expect(await listGlobalIdsForProvider(env, 'p1')).toEqual(['p1/a', 'p1/b']);
		expect(await listAllGlobalModelIds(env)).toEqual(['p1/a', 'p1/b', 'p2/x']);
	});

	it('returns empty arrays when nothing is configured', async () => {
		expect(await listGlobalIdsForProvider(env, 'nope')).toEqual([]);
		expect(await listAllGlobalModelIds(env)).toEqual([]);
	});
});

describe('updateModel', () => {
	it('patches a single field, leaving others alone', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'a', name: 'A', description: 'old', sortOrder: 3 });
		await updateModel(env, 'p1', 'a', { name: 'A2' });
		const after = await getModel(env, 'p1', 'a');
		expect(after?.name).toBe('A2');
		expect(after?.description).toBe('old');
		expect(after?.sortOrder).toBe(3);
	});

	it('clears nullable fields when set to null', async () => {
		await setupProvider();
		await createModel(env, 'p1', {
			id: 'a',
			name: 'A',
			description: 'desc',
			reasoningType: 'effort',
			inputCostPerMillionTokens: 5,
			outputCostPerMillionTokens: 10,
		});
		await updateModel(env, 'p1', 'a', {
			description: null,
			reasoningType: null,
			inputCostPerMillionTokens: null,
			outputCostPerMillionTokens: null,
		});
		const after = await getModel(env, 'p1', 'a');
		expect(after?.description).toBeNull();
		expect(after?.reasoningType).toBeNull();
		expect(after?.inputCostPerMillionTokens).toBeNull();
		expect(after?.outputCostPerMillionTokens).toBeNull();
	});

	it('is a no-op when input is empty', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'a', name: 'A' });
		const before = await getModel(env, 'p1', 'a');
		await updateModel(env, 'p1', 'a', {});
		const after = await getModel(env, 'p1', 'a');
		expect(after).toEqual(before);
	});

	it('updates updated_at when at least one field changes', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'a', name: 'A' });
		const before = await getModel(env, 'p1', 'a');
		await new Promise((r) => setTimeout(r, 5));
		await updateModel(env, 'p1', 'a', { name: 'A2' });
		const after = await getModel(env, 'p1', 'a');
		expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt);
	});
});

describe('deleteModel + deleteModelsForProvider', () => {
	it('deletes a single model row', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'a', name: 'A' });
		await createModel(env, 'p1', { id: 'b', name: 'B' });
		await deleteModel(env, 'p1', 'a');
		const ids = (await listModelsForProvider(env, 'p1')).map((m) => m.id);
		expect(ids).toEqual(['b']);
	});

	it('deleteModelsForProvider clears every model under the provider', async () => {
		await setupProvider('p1');
		await createProvider(env, { id: 'p2', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'a', name: 'A' });
		await createModel(env, 'p1', { id: 'b', name: 'B' });
		await createModel(env, 'p2', { id: 'x', name: 'X' });
		await deleteModelsForProvider(env, 'p1');
		expect(await listModelsForProvider(env, 'p1')).toEqual([]);
		// p2's model is untouched.
		expect((await listModelsForProvider(env, 'p2')).map((m) => m.id)).toEqual(['x']);
	});

	it('deleteModel is scoped by user_id', async () => {
		// providers.id is globally unique so we use a single provider seeded
		// for user 1 and verify a wrong-user delete is a no-op.
		await createProvider(env, { id: 'p-u1', type: 'anthropic' }, 1);
		await createModel(env, 'p-u1', { id: 'a', name: 'A' }, 1);
		await deleteModel(env, 'p-u1', 'a', 2); // wrong user — no-op
		expect((await listModelsForProvider(env, 'p-u1', 1)).map((m) => m.id)).toEqual(['a']);
		await deleteModel(env, 'p-u1', 'a', 1);
		expect(await listModelsForProvider(env, 'p-u1', 1)).toEqual([]);
	});
});

describe('swapModelOrder', () => {
	it('exchanges sort_order between two models', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 1 });
		await createModel(env, 'p1', { id: 'b', name: 'B', sortOrder: 5 });
		await swapModelOrder(env, 'p1', 'a', 'b');
		expect((await getModel(env, 'p1', 'a'))?.sortOrder).toBe(5);
		expect((await getModel(env, 'p1', 'b'))?.sortOrder).toBe(1);
	});

	it('throws when one of the two ids is missing', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 1 });
		await expect(swapModelOrder(env, 'p1', 'a', 'missing')).rejects.toThrow(/not found/);
		await expect(swapModelOrder(env, 'p1', 'missing-1', 'missing-2')).rejects.toThrow(/not found/);
	});
});

describe('getResolvedModel', () => {
	it('returns provider + model + globalId when both exist', async () => {
		await setupProvider();
		await createModel(env, 'p1', { id: 'm', name: 'M' });
		const r = await getResolvedModel(env, 'p1/m');
		expect(r?.globalId).toBe('p1/m');
		expect(r?.provider.id).toBe('p1');
		expect(r?.model.id).toBe('m');
	});

	it('returns null when the provider is missing', async () => {
		// Even with a model row hanging around, no provider → null.
		await setupProvider('p1');
		await createModel(env, 'p1', { id: 'm', name: 'M' });
		expect(await getResolvedModel(env, 'unknown/m')).toBeNull();
	});

	it('returns null when the model is missing', async () => {
		await setupProvider();
		expect(await getResolvedModel(env, 'p1/missing')).toBeNull();
	});

	it('throws on a malformed global id', async () => {
		await expect(getResolvedModel(env, 'no-slash-here')).rejects.toThrow();
	});

	it('handles models whose id contains slashes', async () => {
		await setupProvider();
		// Some real providers have nested model ids ("anthropic/claude-...").
		await createModel(env, 'p1', { id: 'anthropic/claude', name: 'Claude' });
		const r = await getResolvedModel(env, 'p1/anthropic/claude');
		expect(r?.model.id).toBe('anthropic/claude');
	});
});

describe('moveModelToPosition', () => {
	async function setupThreeModels() {
		await setupProvider();
		await createModel(env, 'p1', { id: 'a', name: 'A', sortOrder: 0 });
		await createModel(env, 'p1', { id: 'b', name: 'B', sortOrder: 1 });
		await createModel(env, 'p1', { id: 'c', name: 'C', sortOrder: 2 });
	}

	async function getOrder() {
		const models = await listModelsForProvider(env, 'p1');
		return models.map((m) => m.id);
	}

	it('moves a model from the middle to the front', async () => {
		await setupThreeModels();
		await moveModelToPosition(env, 'p1', 'b', 'a');
		expect(await getOrder()).toEqual(['b', 'a', 'c']);
	});

	it('moves a model from the front to the end (null = end)', async () => {
		await setupThreeModels();
		await moveModelToPosition(env, 'p1', 'a', null);
		expect(await getOrder()).toEqual(['b', 'c', 'a']);
	});

	it('moves a model to before a specific model', async () => {
		await setupThreeModels();
		await moveModelToPosition(env, 'p1', 'c', 'b');
		expect(await getOrder()).toEqual(['a', 'c', 'b']);
	});

	it('is a no-op when the model is referenced before itself (first position)', async () => {
		await setupThreeModels();
		await moveModelToPosition(env, 'p1', 'a', 'a');
		expect(await getOrder()).toEqual(['a', 'b', 'c']);
	});

	it('is a no-op when a non-first model is referenced before itself', async () => {
		await setupThreeModels();
		await moveModelToPosition(env, 'p1', 'b', 'b');
		expect(await getOrder()).toEqual(['a', 'b', 'c']);
	});

	it('falls back to end when beforeModelId is not found (stale reference)', async () => {
		await setupThreeModels();
		await moveModelToPosition(env, 'p1', 'b', 'stale-id');
		expect(await getOrder()).toEqual(['a', 'c', 'b']);
	});

	it('throws when the dragged model does not exist', async () => {
		await setupThreeModels();
		await expect(moveModelToPosition(env, 'p1', 'missing', 'a')).rejects.toThrow('missing');
	});
});
