// Fetch available models from provider APIs for auto-populating presets.

import { z } from 'zod';
import { validateOrThrow } from '$lib/zod-utils';
import type { CuratedModel } from './presets';

const openRouterModelSchema = z
	.object({
		context_length: z.number().optional(),
		description: z.string().optional(),
		id: z.string(),
		name: z.string().optional(),
		top_provider: z.object({ context_length: z.number().optional() }).passthrough().nullable().optional(),
	})
	.passthrough();

const openRouterModelsResponseSchema = z.object({ data: z.array(openRouterModelSchema).optional() }).passthrough();

// OpenRouter's public model endpoint requires no authentication.
export async function fetchOpenRouterModels(apiKey?: string): Promise<CuratedModel[]> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
	if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);

	const data = validateOrThrow(openRouterModelsResponseSchema, await res.json(), 'OpenRouter models response');

	const models = data.data ?? [];
	return models.map((m) => {
		const ctx = m.context_length ?? m.top_provider?.context_length ?? 128_000;
		return {
			description: m.description,
			id: m.id,
			maxContextLength: ctx,
			name: m.name ?? m.id,
			// Infer reasoning type from vendor prefix / model name patterns
			reasoningType: inferReasoningType(m.id),
		};
	});
}

// `RequestInit` plus Cloudflare's non-standard `cf` field, which controls
// edge caching for `fetch()` calls made from a Worker.
export type FetchInitWithCf = RequestInit & { cf?: { cacheTtl?: number; cacheEverything?: boolean } };

// Fetch a JSON document through Cloudflare's edge cache and validate it
// against `schema`. Shared by the models.dev and OpenRouter catalog
// fetchers, which both want the same cache-everything behaviour and the
// same `throw on !res.ok` / `validateOrThrow` boilerplate.
export async function fetchCachedJson<S extends z.ZodTypeAny>(
	url: string,
	schema: S,
	opts: { cacheTtlSeconds: number; errorPrefix: string; label: string },
): Promise<z.infer<S>> {
	const init: FetchInitWithCf = {
		cf: { cacheEverything: true, cacheTtl: opts.cacheTtlSeconds },
		headers: { Accept: 'application/json' },
	};
	const res = await fetch(url, init as RequestInit);
	if (!res.ok) throw new Error(`${opts.errorPrefix}: ${res.status}`);
	return validateOrThrow(schema, await res.json(), opts.label);
}

export function inferReasoningType(modelId: string): 'effort' | 'max_tokens' | undefined {
	const lower = modelId.toLowerCase();
	if (
		lower.startsWith('openai/o') ||
		lower.startsWith('openai/gpt-5') ||
		lower.startsWith('x-ai/grok') ||
		lower.startsWith('google/gemini-3')
	) {
		return 'effort';
	}
	if (
		lower.startsWith('anthropic/claude') ||
		lower.startsWith('claude-') ||
		lower.startsWith('moonshotai/kimi-k2') ||
		lower.startsWith('google/gemini-2.5') ||
		lower.startsWith('alibaba/qwen')
	) {
		return 'max_tokens';
	}
	return undefined;
}
