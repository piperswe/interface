// Fetch and map the models.dev catalog (https://models.dev/api.json) into our
// internal ProviderModel shape so users can browse and bulk-import models with
// metadata (context, costs, modalities, reasoning) prefilled.
//
// The catalog is fetched through Cloudflare's edge cache (cacheTtl 1h); we
// don't persist it ourselves.

import { z } from 'zod';
import { validateOrThrow } from '$lib/zod-utils';
import { inferReasoningType } from './fetch';
import type { CreateModelInput } from './models';
import type { ReasoningType } from './types';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_SECONDS = 3600;
const DEFAULT_CONTEXT_LENGTH = 128_000;

const modelsDevCostSchema = z
	.object({
		input: z.number().optional(),
		output: z.number().optional(),
	})
	.passthrough();

const modelsDevLimitSchema = z
	.object({
		context: z.number().optional(),
		input: z.number().optional(),
		output: z.number().optional(),
	})
	.passthrough();

const modelsDevModalitiesSchema = z
	.object({
		input: z.array(z.string()).optional(),
		output: z.array(z.string()).optional(),
	})
	.passthrough();

const modelsDevModelSchema = z
	.object({
		attachment: z.boolean().optional(),
		cost: modelsDevCostSchema.optional(),
		id: z.string().optional(),
		knowledge: z.string().optional(),
		last_updated: z.string().optional(),
		limit: modelsDevLimitSchema.optional(),
		modalities: modelsDevModalitiesSchema.optional(),
		name: z.string(),
		open_weights: z.boolean().optional(),
		reasoning: z.boolean().optional(),
		release_date: z.string().optional(),
		tool_call: z.boolean().optional(),
	})
	.passthrough();

const modelsDevProviderSchema = z
	.object({
		id: z.string().optional(),
		models: z.record(modelsDevModelSchema),
		name: z.string().optional(),
	})
	.passthrough();

const modelsDevCatalogSchema = z.record(modelsDevProviderSchema);

export interface ModelsDevEntry {
	providerKey: string;
	providerName: string;
	modelId: string;
	name: string;
	contextLength: number;
	inputCost: number | null;
	outputCost: number | null;
	supportsImageInput: boolean;
	supportsReasoning: boolean;
	supportsToolCall: boolean;
	openWeights: boolean;
	releaseDate: string | null;
	knowledge: string | null;
}

type FetchInitWithCf = RequestInit & { cf?: { cacheTtl?: number; cacheEverything?: boolean } };

export async function fetchModelsDevCatalog(): Promise<ModelsDevEntry[]> {
	const init: FetchInitWithCf = {
		cf: { cacheEverything: true, cacheTtl: CACHE_TTL_SECONDS },
		headers: { Accept: 'application/json' },
	};
	const res = await fetch(MODELS_DEV_URL, init as RequestInit);
	if (!res.ok) throw new Error(`models.dev API error: ${res.status}`);

	const catalog = validateOrThrow(modelsDevCatalogSchema, await res.json(), 'models.dev catalog');

	const entries: ModelsDevEntry[] = [];
	for (const [providerKey, provider] of Object.entries(catalog)) {
		const providerName = provider.name ?? providerKey;
		for (const [modelKey, model] of Object.entries(provider.models)) {
			entries.push({
				contextLength: model.limit?.context ?? DEFAULT_CONTEXT_LENGTH,
				inputCost: model.cost?.input ?? null,
				knowledge: model.knowledge ?? null,
				modelId: model.id ?? modelKey,
				name: model.name,
				openWeights: model.open_weights ?? false,
				outputCost: model.cost?.output ?? null,
				providerKey,
				providerName,
				releaseDate: model.release_date ?? null,
				supportsImageInput: (model.modalities?.input ?? []).includes('image'),
				supportsReasoning: model.reasoning ?? false,
				supportsToolCall: model.tool_call ?? false,
			});
		}
	}
	return entries;
}

export function mapToCreateModelInput(entry: ModelsDevEntry, opts: { idPrefix?: string; sortOrder?: number } = {}): CreateModelInput {
	const id = (opts.idPrefix ?? '') + entry.modelId;
	return {
		description: buildDescription(entry),
		id,
		inputCostPerMillionTokens: entry.inputCost,
		maxContextLength: entry.contextLength,
		name: entry.name,
		outputCostPerMillionTokens: entry.outputCost,
		reasoningType: entry.supportsReasoning ? resolveReasoning(entry.providerKey, entry.modelId) : null,
		sortOrder: opts.sortOrder ?? 0,
		supportsImageInput: entry.supportsImageInput,
	};
}

function buildDescription(entry: ModelsDevEntry): string | null {
	const parts: string[] = [];
	if (entry.releaseDate) parts.push(`Released ${entry.releaseDate}`);
	if (entry.knowledge) parts.push(`Knowledge ${entry.knowledge}`);
	return parts.length > 0 ? parts.join(' · ') : null;
}

// Maps a models.dev providerKey/modelId to our ReasoningType. The catalog's
// `reasoning: true` flag only says reasoning is supported; the *flavor*
// (Anthropic-style budgetTokens vs OpenAI-style effort) is provider-specific
// and matters for the request shape we send.
export function resolveReasoning(providerKey: string, modelId: string): ReasoningType | null {
	const key = providerKey.toLowerCase();
	const id = modelId.toLowerCase();

	if (key === 'anthropic') return 'max_tokens';
	if (key === 'openai' || key === 'xai' || key === 'x-ai' || key === 'azure') return 'effort';
	if (key === 'google' || key === 'google-ai-studio' || key === 'google-vertex') {
		if (id.startsWith('gemini-3')) return 'effort';
		if (id.startsWith('gemini-2.5') || id.startsWith('gemini-2-5')) return 'max_tokens';
	}

	const fallback = inferReasoningType(`${key}/${id}`);
	if (fallback) return fallback;
	const bare = inferReasoningType(id);
	return bare ?? null;
}
