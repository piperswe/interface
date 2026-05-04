export type ReasoningType = 'effort' | 'max_tokens';

export type ModelEntry = { slug: string; label: string; reasoning?: ReasoningType };

export const DEFAULT_MODEL_LIST: ModelEntry[] = [
	{ slug: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', reasoning: 'max_tokens' },
	{ slug: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7', reasoning: 'max_tokens' },
	{ slug: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6', reasoning: 'max_tokens' },
	{ slug: 'openai/gpt-5.5', label: 'GPT-5.5', reasoning: 'effort' },
	{ slug: 'google/gemini-2.5-pro-preview-06-05', label: 'Gemini 2.5 Pro Preview', reasoning: 'max_tokens' },
	{ slug: '@cf/moonshotai/kimi-k2.6', label: 'Kimi K2.6 (Workers AI)', reasoning: 'max_tokens' },
	{ slug: '@cf/openai/gpt-oss-120b', label: 'gpt-oss 120B (Workers AI)', reasoning: 'effort' },
	{ slug: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B (Workers AI)' },
];

export function reasoningTypeFor(slug: string): ReasoningType | null {
	const lower = slug.toLowerCase();
	// effort-based models
	if (
		lower.startsWith('openai/o') ||
		lower.startsWith('openai/gpt-5') ||
		lower.startsWith('x-ai/grok') ||
		lower.startsWith('google/gemini-3') ||
		lower.startsWith('@cf/openai/gpt-oss')
	) {
		return 'effort';
	}
	// max_tokens-based models
	if (
		lower.startsWith('anthropic/claude') ||
		lower.startsWith('claude-') ||
		lower.startsWith('moonshotai/kimi-k2') ||
		lower.startsWith('@cf/moonshotai/kimi-k2') ||
		lower.startsWith('google/gemini-2.5') ||
		lower.startsWith('alibaba/qwen')
	) {
		return 'max_tokens';
	}
	return null;
}

export function parseModelList(raw: string | null): ModelEntry[] {
	if (!raw || !raw.trim()) return structuredClone(DEFAULT_MODEL_LIST);
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return structuredClone(DEFAULT_MODEL_LIST);
		const entries: ModelEntry[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== 'object') continue;
			const slug = String((item as Record<string, unknown>).slug ?? '').trim();
			const label = String((item as Record<string, unknown>).label ?? '').trim();
			const reasoningRaw = (item as Record<string, unknown>).reasoning;
			const reasoning: ReasoningType | undefined =
				reasoningRaw === 'effort' || reasoningRaw === 'max_tokens' ? reasoningRaw : undefined;
			if (!slug) continue;
			entries.push({ slug, label: label || slug, ...(reasoning ? { reasoning } : {}) });
		}
		return entries.length > 0 ? entries : structuredClone(DEFAULT_MODEL_LIST);
	} catch {
		return structuredClone(DEFAULT_MODEL_LIST);
	}
}

export function serializeModelList(models: ModelEntry[]): string {
	return JSON.stringify(models, null, 2);
}
