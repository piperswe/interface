import type { ChatRequest, ReasoningConfig, ReasoningEffort } from '../../llm/LLM';

export function budgetToEffort(budget: number): ReasoningEffort | null {
	if (budget <= 0) return null;
	if (budget <= 1024) return 'low';
	if (budget <= 4096) return 'medium';
	if (budget <= 16384) return 'high';
	return 'xhigh';
}

// Translate the per-conversation thinking budget into the right provider
// shape. Native Anthropic uses the legacy `thinking` field; everything else
// uses `reasoning`. Only one is ever set so AnthropicLLM never has to
// disambiguate. Returns `{}` (both undefined) when the budget is null/zero
// or the model has no compatible reasoning surface.
export function resolveReasoningConfig(opts: {
	thinkingBudget: number | null;
	reasoningType: string | null;
	providerType: string | null;
}): { reasoning?: ReasoningConfig; thinking?: ChatRequest['thinking'] } {
	const { thinkingBudget, reasoningType, providerType } = opts;
	if (thinkingBudget == null || thinkingBudget <= 0) return {};
	const isNativeAnthropic = providerType === 'anthropic';
	if (isNativeAnthropic) {
		return { thinking: { type: 'enabled', budgetTokens: thinkingBudget } };
	}
	if (reasoningType === 'effort') {
		const effort = budgetToEffort(thinkingBudget);
		return effort ? { reasoning: { type: 'effort', effort } } : {};
	}
	if (reasoningType === 'max_tokens') {
		return { reasoning: { type: 'max_tokens', maxTokens: thinkingBudget } };
	}
	return {};
}
