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
// disambiguate.
//
// For native Anthropic models that support thinking (reasoningType != null),
// we always emit an explicit thinking config — `disabled` when the budget is
// null/zero so the model never silently inherits thinking state from context,
// `enabled` otherwise. For all other providers we omit the field when off
// because their APIs have no `disabled` shape.
export function resolveReasoningConfig(opts: {
	thinkingBudget: number | null;
	reasoningType: string | null;
	providerType: string | null;
}): { reasoning?: ReasoningConfig; thinking?: ChatRequest['thinking'] } {
	const { thinkingBudget, reasoningType, providerType } = opts;
	const isNativeAnthropic = providerType === 'anthropic';
	if (thinkingBudget == null || thinkingBudget <= 0) {
		// Explicitly disable thinking/reasoning so the intent is unambiguous to
		// the provider. Omitting the field relies on the default (which may not be
		// "off" for all thinking-capable models).
		if (isNativeAnthropic && reasoningType != null) {
			return { thinking: { type: 'disabled' } };
		}
		if (reasoningType === 'effort') {
			return { reasoning: { type: 'effort', effort: 'none' } };
		}
		return {};
	}
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
