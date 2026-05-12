// Fetch available models from provider APIs for auto-populating presets.

import { z } from 'zod';
import { validateOrThrow } from '$lib/zod-utils';
import type { CuratedModel } from './presets';

const openRouterModelSchema = z
	.object({
		id: z.string(),
		name: z.string().optional(),
		context_length: z.number().optional(),
		top_provider: z
			.object({ context_length: z.number().optional() })
			.passthrough()
			.nullable()
			.optional(),
		description: z.string().optional(),
	})
	.passthrough();

const openRouterModelsResponseSchema = z
	.object({ data: z.array(openRouterModelSchema).optional() })
	.passthrough();

// OpenRouter's public model endpoint requires no authentication.
export async function fetchOpenRouterModels(apiKey?: string): Promise<CuratedModel[]> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
	if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);

	const data = validateOrThrow(
		openRouterModelsResponseSchema,
		await res.json(),
		'OpenRouter models response',
	);

	const models = data.data ?? [];
	return models.map((m) => {
		const ctx = m.context_length ?? m.top_provider?.context_length ?? 128_000;
		return {
			id: m.id,
			name: m.name ?? m.id,
			description: m.description,
			maxContextLength: ctx,
			// Infer reasoning type from vendor prefix / model name patterns
			reasoningType: inferReasoningType(m.id),
		};
	});
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
