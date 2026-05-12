import { form, command, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { createProvider, deleteProvider, getProvider, updateProvider, isValidProviderId } from '$lib/server/providers/store';
import { createModel, deleteModel, getModel, listModelsForProvider, updateModel, swapModelOrder } from '$lib/server/providers/models';
import { fetchOpenRouterModels } from '$lib/server/providers/fetch';
import { getPresetById } from '$lib/server/providers/presets';
import { fetchModelsDevCatalog, mapToCreateModelInput } from '$lib/server/providers/modelsDev';
import { fetchOpenRouterCatalog, mapOpenRouterToCreateModelInput } from '$lib/server/providers/openRouter';
import {
	checkboxBoolean,
	trimmedNonEmpty,
	trimmedOptionalOrNull,
} from '$lib/server/remote-schemas';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

const PROVIDER_ID_RULE =
	'Provider ID must start with a letter and contain only lowercase letters, digits, underscores, or hyphens (max 64 chars).';

const providerIdField = z
	.string()
	.trim()
	.refine((v) => v.length > 0 && isValidProviderId(v), PROVIDER_ID_RULE);

export const saveProvider = form(
	z.object({
		id: providerIdField,
		type: z.enum(['anthropic', 'openai_compatible'], {
			errorMap: (_issue, ctx) => ({ message: `Invalid provider type: ${ctx.data}` }),
		}),
		api_key: trimmedOptionalOrNull,
		endpoint: trimmedOptionalOrNull,
		gateway_id: trimmedOptionalOrNull,
	}),
	async ({ id, type, api_key, endpoint, gateway_id }) => {
		const env = getEnv();

		// Check if this is an update or create by seeing if the provider exists
		const existing = await getProvider(env, id);

		if (existing) {
			await updateProvider(env, id, { apiKey: api_key, endpoint, gatewayId: gateway_id });
		} else {
			await createProvider(env, { id, type, apiKey: api_key, endpoint, gatewayId: gateway_id });
		}

		redirect(303, '/settings');
	},
);

export const deleteProviderAction = form(
	z.object({ id: trimmedNonEmpty('Provider ID required') }),
	async ({ id }) => {
		await deleteProvider(getEnv(), id);
		redirect(303, '/settings');
	},
);

const optionalNonNegativeFloat = (label: string) =>
	z
		.string()
		.optional()
		.transform((v, ctx) => {
			const t = (v ?? '').trim();
			if (t === '') return null;
			const n = Number.parseFloat(t);
			if (!Number.isFinite(n) || n < 0) {
				ctx.addIssue({ code: 'custom', message: `${label} must be a non-negative number` });
				return z.NEVER;
			}
			return n;
		});

const optionalPositiveIntWithDefault = (defaultValue: number, label: string) =>
	z
		.string()
		.optional()
		.transform((v, ctx) => {
			const t = (v ?? '').trim();
			if (t === '') return defaultValue;
			const n = Number.parseInt(t, 10);
			if (!Number.isFinite(n) || n < 1) {
				ctx.addIssue({ code: 'custom', message: label });
				return z.NEVER;
			}
			return n;
		});

export const saveProviderModel = form(
	z.object({
		provider_id: trimmedNonEmpty('Provider ID required'),
		model_id: trimmedNonEmpty('Model ID required'),
		name: trimmedNonEmpty('Model name required'),
		description: trimmedOptionalOrNull,
		max_context_length: optionalPositiveIntWithDefault(
			128_000,
			'Max context length must be a positive integer',
		),
		reasoning_type: z
			.string()
			.optional()
			.transform((v, ctx) => {
				if (v === undefined || v === '') return null;
				if (v === 'effort' || v === 'max_tokens') return v;
				ctx.addIssue({ code: 'custom', message: `Invalid reasoning type: ${v}` });
				return z.NEVER;
			}),
		input_cost_per_million_tokens: optionalNonNegativeFloat('Input cost per million tokens'),
		output_cost_per_million_tokens: optionalNonNegativeFloat('Output cost per million tokens'),
		supports_image_input: checkboxBoolean,
	}),
	async ({
		provider_id,
		model_id,
		name,
		description,
		max_context_length,
		reasoning_type,
		input_cost_per_million_tokens,
		output_cost_per_million_tokens,
		supports_image_input,
	}) => {
		const env = getEnv();
		const existing = await getModel(env, provider_id, model_id);

		if (existing) {
			await updateModel(env, provider_id, model_id, {
				name,
				description,
				maxContextLength: max_context_length,
				reasoningType: reasoning_type,
				inputCostPerMillionTokens: input_cost_per_million_tokens,
				outputCostPerMillionTokens: output_cost_per_million_tokens,
				supportsImageInput: supports_image_input,
			});
		} else {
			await createModel(env, provider_id, {
				id: model_id,
				name,
				description,
				maxContextLength: max_context_length,
				reasoningType: reasoning_type,
				inputCostPerMillionTokens: input_cost_per_million_tokens,
				outputCostPerMillionTokens: output_cost_per_million_tokens,
				supportsImageInput: supports_image_input,
			});
		}

		redirect(303, '/settings');
	},
);

export const deleteProviderModel = form(
	z.object({
		provider_id: trimmedNonEmpty('Provider ID and Model ID required'),
		model_id: trimmedNonEmpty('Provider ID and Model ID required'),
	}),
	async ({ provider_id, model_id }) => {
		await deleteModel(getEnv(), provider_id, model_id);
		redirect(303, '/settings');
	},
);

export const reorderProviderModel = form(
	z.object({
		provider_id: trimmedNonEmpty('Provider ID and Model ID required'),
		model_id: trimmedNonEmpty('Provider ID and Model ID required'),
		direction: z.enum(['up', 'down'], {
			errorMap: () => ({ message: 'Direction must be up or down' }),
		}),
	}),
	async ({ provider_id, model_id, direction }) => {
		const env = getEnv();
		const models = await listModelsForProvider(env, provider_id);
		const idx = models.findIndex((m) => m.id === model_id);
		if (idx === -1) error(400, 'Model not found');

		const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= models.length) {
			// Already at boundary; nothing to do
			redirect(303, '/settings');
		}

		await swapModelOrder(env, provider_id, model_id, models[swapIdx].id);
		redirect(303, '/settings');
	},
);

export const addPresetProvider = form(
	z.object({
		id: trimmedNonEmpty('Preset ID required'),
		provider_id: providerIdField,
		api_key: trimmedOptionalOrNull,
		endpoint: trimmedOptionalOrNull,
		model_ids: z.string().optional().default(''),
	}),
	async ({ id: presetId, provider_id, api_key, endpoint, model_ids }) => {
		const preset = getPresetById(presetId);
		if (!preset) error(400, `Unknown preset: ${presetId}`);

		const env = getEnv();

		// Pre-check uniqueness so the user gets a clean 400 instead of
		// a unique-constraint 500 from D1.
		const conflict = await getProvider(env, provider_id);
		if (conflict) {
			error(400, `Provider id "${provider_id}" already exists. Edit it or pick a different id.`);
		}

		// Create the provider
		await createProvider(env, {
			id: provider_id,
			type: preset.type,
			apiKey: api_key,
			endpoint: endpoint || preset.defaultEndpoint || null,
		});

		// Add selected models (or all default models if none selected)
		const selectedIds = model_ids ? model_ids.split(',').filter(Boolean) : [];
		const modelsToAdd =
			selectedIds.length > 0 ? preset.defaultModels.filter((m) => selectedIds.includes(m.id)) : preset.defaultModels;

		for (let i = 0; i < modelsToAdd.length; i++) {
			const m = modelsToAdd[i];
			await createModel(env, provider_id, {
				id: m.id,
				name: m.name,
				description: m.description ?? null,
				maxContextLength: m.maxContextLength,
				reasoningType: m.reasoningType ?? null,
				sortOrder: i * 10, // leave gaps for future inserts
			});
		}

		redirect(303, '/settings');
	},
);

export const fetchPresetModels = command(
	z.object({
		preset_id: trimmedNonEmpty('Preset ID required'),
		api_key: z.string().trim().optional(),
	}),
	async ({ preset_id, api_key }) => {
		const preset = getPresetById(preset_id);
		if (!preset) error(400, `Unknown preset: ${preset_id}`);
		if (!preset.canFetchModels) error(400, `Preset ${preset_id} does not support model fetching`);

		if (preset_id === 'openrouter') {
			return await fetchOpenRouterModels(api_key || undefined);
		}

		return [];
	},
);

// Models.dev catalog fetch. The full flattened list (~hundreds of entries) is
// returned to the client; the picker UI filters in-memory. Cached at the
// Cloudflare edge for 1h, so repeat opens within that window are free.
export const searchModelsDev = command(z.void(), async () => {
	return await fetchModelsDevCatalog();
});

export const importModelsFromDev = form(
	z.object({
		provider_id: trimmedNonEmpty('Provider ID required'),
		model_keys: trimmedNonEmpty('Select at least one model'),
		id_prefix: z.string().optional().default(''),
	}),
	async ({ provider_id, model_keys, id_prefix }) => {
		const env = getEnv();
		const provider = await getProvider(env, provider_id);
		if (!provider) error(400, `Provider not found: ${provider_id}`);

		const catalog = await fetchModelsDevCatalog();
		const byKey = new Map(catalog.map((e) => [`${e.providerKey}:${e.modelId}`, e]));

		const keys = model_keys.split(',').filter(Boolean);
		const existing = await listModelsForProvider(env, provider_id);
		// Derive from the actual max sortOrder, not the count: deletions and
		// manual reorders can leave gaps, so `count * 10` may overlap existing
		// entries rather than appending after them.
		const baseSort = existing.length > 0 ? Math.max(...existing.map((m) => m.sortOrder)) + 10 : 0;

		let i = 0;
		for (const key of keys) {
			const entry = byKey.get(key);
			if (!entry) {
				i++;
				continue;
			}
			const input = mapToCreateModelInput(entry, {
				idPrefix: id_prefix.trim(),
				sortOrder: baseSort + i * 10,
			});
			// Skip silently if id already exists — re-imports shouldn't 500 on the
			// (provider_id, id) UNIQUE constraint.
			if (await getModel(env, provider_id, input.id)) {
				i++;
				continue;
			}
			await createModel(env, provider_id, input);
			i++;
		}

		redirect(303, '/settings');
	},
);

// OpenRouter catalog fetch. Parallel to `searchModelsDev`: returns the full
// flattened list to the client and the picker UI filters in-memory.
export const searchOpenRouter = command(z.void(), async () => {
	return await fetchOpenRouterCatalog();
});

export const importModelsFromOpenRouter = form(
	z.object({
		provider_id: trimmedNonEmpty('Provider ID required'),
		model_keys: trimmedNonEmpty('Select at least one model'),
	}),
	async ({ provider_id, model_keys }) => {
		const env = getEnv();
		const provider = await getProvider(env, provider_id);
		if (!provider) error(400, `Provider not found: ${provider_id}`);

		const catalog = await fetchOpenRouterCatalog();
		// OpenRouter ids are globally unique, so the fullId is the selection key
		// and is used directly as the stored model id (no prefix needed).
		const byKey = new Map(catalog.map((e) => [e.fullId, e]));

		const keys = model_keys.split(',').filter(Boolean);
		const existing = await listModelsForProvider(env, provider_id);
		const baseSort = existing.length > 0 ? Math.max(...existing.map((m) => m.sortOrder)) + 10 : 0;

		let i = 0;
		for (const key of keys) {
			const entry = byKey.get(key);
			if (!entry) {
				i++;
				continue;
			}
			const input = mapOpenRouterToCreateModelInput(entry, { sortOrder: baseSort + i * 10 });
			if (await getModel(env, provider_id, input.id)) {
				i++;
				continue;
			}
			await createModel(env, provider_id, input);
			i++;
		}

		redirect(303, '/settings');
	},
);
