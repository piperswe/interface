import { form, command, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { createProvider, deleteProvider, getProvider, updateProvider, isValidProviderId } from '$lib/server/providers/store';
import { createModel, deleteModel, getModel, listModelsForProvider, updateModel, swapModelOrder } from '$lib/server/providers/models';
import { fetchOpenRouterModels } from '$lib/server/providers/fetch';
import { getPresetById } from '$lib/server/providers/presets';
import type { ProviderType, ReasoningType } from '$lib/server/providers/types';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

function validateProviderType(v: unknown): ProviderType {
	if (v === 'anthropic' || v === 'openai_compatible') return v;
	error(400, `Invalid provider type: ${v}`);
}

function validateReasoningType(v: unknown): ReasoningType | null {
	if (v === 'effort' || v === 'max_tokens') return v;
	if (v == null || v === '') return null;
	error(400, `Invalid reasoning type: ${v}`);
}

export const saveProvider = form(
	'unchecked',
	async (data: { id?: unknown; type?: unknown; api_key?: unknown; endpoint?: unknown; gateway_id?: unknown }) => {
		const id = String(data.id ?? '').trim();
		const type = validateProviderType(data.type);
		const apiKey = String(data.api_key ?? '').trim() || null;
		const endpoint = String(data.endpoint ?? '').trim() || null;
		const gatewayId = String(data.gateway_id ?? '').trim() || null;

		if (!id || !isValidProviderId(id)) {
			error(
				400,
				'Provider ID must start with a letter and contain only lowercase letters, digits, underscores, or hyphens (max 64 chars).',
			);
		}

		const env = getEnv();

		// Check if this is an update or create by seeing if the provider exists
		const existing = await getProvider(env, id);

		if (existing) {
			await updateProvider(env, id, { apiKey, endpoint, gatewayId });
		} else {
			await createProvider(env, { id, type, apiKey, endpoint, gatewayId });
		}

		redirect(303, '/settings');
	},
);

export const deleteProviderAction = form('unchecked', async (data: { id?: unknown }) => {
	const id = String(data.id ?? '').trim();
	if (!id) error(400, 'Provider ID required');
	await deleteProvider(getEnv(), id);
	redirect(303, '/settings');
});

function parseOptionalCost(raw: unknown, label: string): number | null {
	const trimmed = String(raw ?? '').trim();
	if (!trimmed) return null;
	const n = Number.parseFloat(trimmed);
	if (!Number.isFinite(n) || n < 0) {
		error(400, `${label} must be a non-negative number`);
	}
	return n;
}

export const saveProviderModel = form(
	'unchecked',
	async (data: {
		provider_id?: unknown;
		model_id?: unknown;
		name?: unknown;
		description?: unknown;
		max_context_length?: unknown;
		reasoning_type?: unknown;
		input_cost_per_million_tokens?: unknown;
		output_cost_per_million_tokens?: unknown;
		supports_image_input?: unknown;
	}) => {
		const providerId = String(data.provider_id ?? '').trim();
		const modelId = String(data.model_id ?? '').trim();
		const name = String(data.name ?? '').trim();
		const description = String(data.description ?? '').trim() || null;
		const maxContextLengthRaw = String(data.max_context_length ?? '').trim();
		const reasoningType = validateReasoningType(data.reasoning_type);
		const inputCostPerMillionTokens = parseOptionalCost(data.input_cost_per_million_tokens, 'Input cost per million tokens');
		const outputCostPerMillionTokens = parseOptionalCost(data.output_cost_per_million_tokens, 'Output cost per million tokens');
		// HTML checkbox sends 'on' (or 'true' / '1') when checked, omits when unchecked.
		const supportsImageInput = (() => {
			const v = data.supports_image_input;
			if (v == null || v === '') return false;
			const s = String(v).toLowerCase();
			return s === 'on' || s === 'true' || s === '1';
		})();

		if (!providerId) error(400, 'Provider ID required');
		if (!modelId) error(400, 'Model ID required');
		if (!name) error(400, 'Model name required');

		const maxContextLength = maxContextLengthRaw ? Number.parseInt(maxContextLengthRaw, 10) : 128_000;
		if (!Number.isFinite(maxContextLength) || maxContextLength < 1) {
			error(400, 'Max context length must be a positive integer');
		}

		const env = getEnv();
		const existing = await getModel(env, providerId, modelId);

		if (existing) {
			await updateModel(env, providerId, modelId, {
				name,
				description,
				maxContextLength,
				reasoningType,
				inputCostPerMillionTokens,
				outputCostPerMillionTokens,
				supportsImageInput,
			});
		} else {
			await createModel(env, providerId, {
				id: modelId,
				name,
				description,
				maxContextLength,
				reasoningType,
				inputCostPerMillionTokens,
				outputCostPerMillionTokens,
				supportsImageInput,
			});
		}

		redirect(303, '/settings');
	},
);

export const deleteProviderModel = form('unchecked', async (data: { provider_id?: unknown; model_id?: unknown }) => {
	const providerId = String(data.provider_id ?? '').trim();
	const modelId = String(data.model_id ?? '').trim();
	if (!providerId || !modelId) error(400, 'Provider ID and Model ID required');
	await deleteModel(getEnv(), providerId, modelId);
	redirect(303, '/settings');
});

export const reorderProviderModel = form('unchecked', async (data: { provider_id?: unknown; model_id?: unknown; direction?: unknown }) => {
	const providerId = String(data.provider_id ?? '').trim();
	const modelId = String(data.model_id ?? '').trim();
	const direction = String(data.direction ?? '').trim();

	if (!providerId || !modelId) error(400, 'Provider ID and Model ID required');
	if (direction !== 'up' && direction !== 'down') error(400, 'Direction must be up or down');

	const env = getEnv();
	const models = await listModelsForProvider(env, providerId);
	const idx = models.findIndex((m) => m.id === modelId);
	if (idx === -1) error(400, 'Model not found');

	const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
	if (swapIdx < 0 || swapIdx >= models.length) {
		// Already at boundary; nothing to do
		redirect(303, '/settings');
	}

	await swapModelOrder(env, providerId, modelId, models[swapIdx].id);
	redirect(303, '/settings');
});

export const addPresetProvider = form(
	'unchecked',
	async (data: { id?: unknown; provider_id?: unknown; api_key?: unknown; endpoint?: unknown; model_ids?: unknown }) => {
		const presetId = String(data.id ?? '').trim();
		const providerId = String(data.provider_id ?? '').trim();
		const apiKey = String(data.api_key ?? '').trim() || null;
		const endpoint = String(data.endpoint ?? '').trim() || null;
		const modelIdsRaw = String(data.model_ids ?? '').trim();

		if (!presetId) error(400, 'Preset ID required');
		if (!providerId || !isValidProviderId(providerId)) {
			error(
				400,
				'Provider ID must start with a letter and contain only lowercase letters, digits, underscores, or hyphens (max 64 chars).',
			);
		}

		const preset = getPresetById(presetId);
		if (!preset) error(400, `Unknown preset: ${presetId}`);

		const env = getEnv();

		// Pre-check uniqueness so the user gets a clean 400 instead of
		// a unique-constraint 500 from D1.
		const conflict = await getProvider(env, providerId);
		if (conflict) {
			error(400, `Provider id "${providerId}" already exists. Edit it or pick a different id.`);
		}

		// Create the provider
		await createProvider(env, {
			id: providerId,
			type: preset.type,
			apiKey,
			endpoint: endpoint || preset.defaultEndpoint || null,
		});

		// Add selected models (or all default models if none selected)
		const selectedIds = modelIdsRaw ? modelIdsRaw.split(',').filter(Boolean) : [];
		const modelsToAdd = selectedIds.length > 0 ? preset.defaultModels.filter((m) => selectedIds.includes(m.id)) : preset.defaultModels;

		for (let i = 0; i < modelsToAdd.length; i++) {
			const m = modelsToAdd[i];
			await createModel(env, providerId, {
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

export const fetchPresetModels = command('unchecked', async (data: { preset_id?: unknown; api_key?: unknown }) => {
	const presetId = String(data.preset_id ?? '').trim();
	const apiKey = String(data.api_key ?? '').trim() || undefined;

	if (!presetId) error(400, 'Preset ID required');
	const preset = getPresetById(presetId);
	if (!preset) error(400, `Unknown preset: ${presetId}`);
	if (!preset.canFetchModels) error(400, `Preset ${presetId} does not support model fetching`);

	if (presetId === 'openrouter') {
		return await fetchOpenRouterModels(apiKey);
	}

	return [];
});
