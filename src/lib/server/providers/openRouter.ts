// Fetch and map the OpenRouter model catalog
// (https://openrouter.ai/api/v1/models) into our internal ProviderModel shape
// so users can browse and bulk-import OpenRouter-listed models with pricing,
// modalities, and reasoning style prefilled.
//
// Mirrors `modelsDev.ts` in shape; kept separate because the source schema and
// pricing convention differ.

import { z } from 'zod';
import { validateOrThrow } from '$lib/zod-utils';
import type { CreateModelInput } from './models';
import type { ReasoningType } from './types';
import { inferReasoningType } from './fetch';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_SECONDS = 3600;
const DEFAULT_CONTEXT_LENGTH = 128_000;
const MAX_DESCRIPTION_LENGTH = 280;

const openRouterArchitectureSchema = z
	.object({
		input_modalities: z.array(z.string()).optional(),
		output_modalities: z.array(z.string()).optional(),
	})
	.passthrough();

const openRouterPricingSchema = z
	.object({
		prompt: z.string().optional(),
		completion: z.string().optional(),
	})
	.passthrough();

const openRouterTopProviderSchema = z
	.object({
		context_length: z.number().nullable().optional(),
	})
	.passthrough();

const openRouterModelSchema = z
	.object({
		id: z.string(),
		name: z.string().optional(),
		description: z.string().optional(),
		context_length: z.number().nullable().optional(),
		architecture: openRouterArchitectureSchema.optional(),
		pricing: openRouterPricingSchema.optional(),
		top_provider: openRouterTopProviderSchema.nullable().optional(),
		supported_parameters: z.array(z.string()).optional(),
		knowledge_cutoff: z.string().nullable().optional(),
	})
	.passthrough();

const openRouterResponseSchema = z
	.object({
		data: z.array(openRouterModelSchema).optional(),
	})
	.passthrough();

export interface OpenRouterEntry {
	vendor: string;
	bareId: string;
	fullId: string;
	name: string;
	description: string | null;
	contextLength: number;
	inputCostPerMillionTokens: number | null;
	outputCostPerMillionTokens: number | null;
	supportsImageInput: boolean;
	supportsReasoning: boolean;
	reasoningType: ReasoningType | null;
	knowledgeCutoff: string | null;
}

type FetchInitWithCf = RequestInit & { cf?: { cacheTtl?: number; cacheEverything?: boolean } };

export async function fetchOpenRouterCatalog(): Promise<OpenRouterEntry[]> {
	const init: FetchInitWithCf = {
		headers: { Accept: 'application/json' },
		cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
	};
	const res = await fetch(OPENROUTER_MODELS_URL, init as RequestInit);
	if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);

	const parsed = validateOrThrow(openRouterResponseSchema, await res.json(), 'OpenRouter models catalog');

	const entries: OpenRouterEntry[] = [];
	for (const model of parsed.data ?? []) {
		const { vendor, bareId } = splitId(model.id);
		const reasoningType = resolveReasoningFromSupported(model.supported_parameters) ?? inferReasoningType(model.id) ?? null;
		entries.push({
			vendor,
			bareId,
			fullId: model.id,
			name: model.name ?? model.id,
			description: buildDescription(model.description, model.knowledge_cutoff),
			contextLength: model.context_length ?? model.top_provider?.context_length ?? DEFAULT_CONTEXT_LENGTH,
			inputCostPerMillionTokens: parsePerTokenCost(model.pricing?.prompt),
			outputCostPerMillionTokens: parsePerTokenCost(model.pricing?.completion),
			supportsImageInput: (model.architecture?.input_modalities ?? []).includes('image'),
			supportsReasoning: reasoningType !== null,
			reasoningType,
			knowledgeCutoff: model.knowledge_cutoff ?? null,
		});
	}
	return entries;
}

export function mapOpenRouterToCreateModelInput(
	entry: OpenRouterEntry,
	opts: { idPrefix?: string; sortOrder?: number } = {},
): CreateModelInput {
	const id = (opts.idPrefix ?? '') + entry.bareId;
	return {
		id,
		name: entry.name,
		description: entry.description,
		maxContextLength: entry.contextLength,
		reasoningType: entry.reasoningType,
		inputCostPerMillionTokens: entry.inputCostPerMillionTokens,
		outputCostPerMillionTokens: entry.outputCostPerMillionTokens,
		supportsImageInput: entry.supportsImageInput,
		sortOrder: opts.sortOrder ?? 0,
	};
}

function splitId(id: string): { vendor: string; bareId: string } {
	const i = id.indexOf('/');
	if (i === -1) return { vendor: id, bareId: id };
	return { vendor: id.slice(0, i), bareId: id.slice(i + 1) };
}

// OpenRouter's `pricing.prompt` / `pricing.completion` are strings of USD per
// token (e.g. "0.000003" = $3 per 1M tokens). Convert to per-million and round
// to 3 decimal places so floating-point noise doesn't surface in the UI.
// Empty, "0", and non-finite values become null.
function parsePerTokenCost(raw: string | undefined): number | null {
	if (raw == null) return null;
	const trimmed = raw.trim();
	if (trimmed === '' || trimmed === '0') return null;
	const n = Number.parseFloat(trimmed);
	if (!Number.isFinite(n) || n <= 0) return null;
	return Math.round(n * 1_000_000 * 1000) / 1000;
}

// Prefer explicit `supported_parameters` (the most reliable signal: the model's
// supported request shape). Falls through to model-id inference for older or
// non-conforming entries.
function resolveReasoningFromSupported(supported: string[] | undefined): ReasoningType | null {
	if (!supported || supported.length === 0) return null;
	if (supported.includes('reasoning_effort')) return 'effort';
	if (supported.includes('reasoning')) return 'max_tokens';
	return null;
}

function buildDescription(description: string | undefined, knowledge: string | null | undefined): string | null {
	const base = (description ?? '').trim();
	const cutoff = (knowledge ?? '').trim();
	const parts: string[] = [];
	if (base) parts.push(base);
	if (cutoff) parts.push(`Knowledge ${cutoff}`);
	if (parts.length === 0) return null;
	const joined = parts.join(' · ');
	if (joined.length <= MAX_DESCRIPTION_LENGTH) return joined;
	return joined.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd() + '…';
}
