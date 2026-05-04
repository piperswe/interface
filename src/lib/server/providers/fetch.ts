// Fetch available models from provider APIs for auto-populating presets.

import type { CuratedModel } from './presets';

// OpenRouter's public model endpoint requires no authentication.
export async function fetchOpenRouterModels(apiKey?: string): Promise<CuratedModel[]> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
	if (!res.ok) throw new Error(`OpenRouter API error: ${res.status}`);

	const data = (await res.json()) as {
		data?: Array<{
			id: string;
			name?: string;
			context_length?: number;
			top_provider?: { context_length?: number } | null;
			description?: string;
		}>;
	};

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

function inferReasoningType(modelId: string): 'effort' | 'max_tokens' | undefined {
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
