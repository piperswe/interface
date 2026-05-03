export type ModelEntry = { slug: string; label: string };

export const DEFAULT_MODEL_LIST: ModelEntry[] = [
	{ slug: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
	{ slug: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7' },
	{ slug: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
	{ slug: 'openai/gpt-5.5', label: 'GPT-5.5' },
	{ slug: 'google/gemini-2.5-pro-preview-06-05', label: 'Gemini 2.5 Pro Preview' },
];

export function parseModelList(raw: string | null): ModelEntry[] {
	if (!raw || !raw.trim()) return [...DEFAULT_MODEL_LIST];
	const entries: ModelEntry[] = [];
	for (const line of raw.trim().split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const idx = trimmed.indexOf('|');
		if (idx === -1) {
			// slug only — use slug as label
			entries.push({ slug: trimmed, label: trimmed });
		} else {
			entries.push({ slug: trimmed.slice(0, idx).trim(), label: trimmed.slice(idx + 1).trim() });
		}
	}
	return entries.length > 0 ? entries : [...DEFAULT_MODEL_LIST];
}

export function serializeModelList(models: ModelEntry[]): string {
	return models.map((m) => `${m.slug}|${m.label}`).join('\n');
}
