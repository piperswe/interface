// Thinking-budget presets, loosely modeled on Anthropic's published ranges
// for extended thinking. Lives in its own module so it can be unit-tested
// without the Svelte compiler.

export type Preset = { id: string; label: string; budget: number | null };

export const THINKING_PRESETS: Preset[] = [
	{ budget: null, id: 'off', label: 'Off' },
	{ budget: 1024, id: 'low', label: 'Low' },
	{ budget: 4096, id: 'medium', label: 'Medium' },
	{ budget: 16384, id: 'high', label: 'High' },
	// `xhigh` matches the reasoning effort name used by AnthropicLLM and
	// `budgetToEffort` in the DO, so the preset id and the underlying provider
	// effort string line up.
	{ budget: 32768, id: 'xhigh', label: 'Extra high' },
];

export function presetFor(budget: number | null): Preset | null {
	if (budget == null || budget <= 0) return THINKING_PRESETS[0];
	return THINKING_PRESETS.find((p) => p.budget === budget) ?? null;
}

export function describeBudget(budget: number | null): string {
	const matched = presetFor(budget);
	if (matched) return matched.label;
	return budget != null ? `${budget.toLocaleString()} tok` : 'Off';
}
