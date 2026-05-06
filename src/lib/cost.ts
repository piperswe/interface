// Cost calculation for an assistant turn.
//
// Three sources, in priority order:
//   1. `usage.cost` reported directly by the provider (e.g. OpenRouter when
//      `usage: { include: true }` is set on the request). When present, this
//      is treated as authoritative for token cost.
//   2. Per-model `inputCostPerMillionTokens` / `outputCostPerMillionTokens`
//      configured by the user (USD). Cache-read and cache-write tokens are
//      billed at the input rate — we don't model provider-specific
//      cache discounts because users would have to set per-token-type rates
//      manually anyway, and most pricing pages quote a single input rate.
//   3. No cost — return null for the LLM portion.
//
// Web-search calls (Kagi) are billed independently and added on top.

import type { ConversationUsage, MessagePart, MessageRow } from '$lib/types/conversation';

export type CostInput = {
	usage: ConversationUsage | null | undefined;
	model: {
		inputCostPerMillionTokens: number | null;
		outputCostPerMillionTokens: number | null;
	} | null;
	webSearchCount: number;
	kagiCostPer1000Searches: number;
};

export type CostBreakdown = {
	llmCost: number | null;
	webSearchCost: number;
	total: number | null;
};

export function computeCost(input: CostInput): CostBreakdown {
	const llmCost = computeLlmCost(input.usage, input.model);
	const webSearchCost = computeWebSearchCost(input.webSearchCount, input.kagiCostPer1000Searches);
	const total =
		llmCost == null && webSearchCost === 0
			? null
			: (llmCost ?? 0) + webSearchCost;
	return { llmCost, webSearchCost, total };
}

function computeLlmCost(
	usage: CostInput['usage'],
	model: CostInput['model'],
): number | null {
	if (!usage) return null;
	if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
		return usage.cost;
	}
	if (!model) return null;
	const inRate = model.inputCostPerMillionTokens;
	const outRate = model.outputCostPerMillionTokens;
	if (inRate == null && outRate == null) return null;
	const billedInput =
		(usage.inputTokens ?? 0) +
		(usage.cacheReadInputTokens ?? 0) +
		(usage.cacheCreationInputTokens ?? 0);
	const billedOutput = usage.outputTokens ?? 0;
	const inputCost = inRate != null ? (billedInput * inRate) / 1_000_000 : 0;
	const outputCost = outRate != null ? (billedOutput * outRate) / 1_000_000 : 0;
	return inputCost + outputCost;
}

function computeWebSearchCost(searches: number, costPer1000: number): number {
	if (!Number.isFinite(searches) || searches <= 0) return 0;
	if (!Number.isFinite(costPer1000) || costPer1000 <= 0) return 0;
	return (searches * costPer1000) / 1000;
}

export type ModelPricing = {
	inputCostPerMillionTokens: number | null;
	outputCostPerMillionTokens: number | null;
};

// Sum the per-assistant-message costs into a single conversation total.
// `lookupModelPricing` receives the global model id stored on each message
// (e.g. "openrouter/anthropic/claude-sonnet"). Messages whose model is no
// longer in the configured registry contribute their provider-reported cost
// (if any) and zero LLM cost otherwise — search costs are still counted.
export function computeConversationCost(
	messages: readonly MessageRow[],
	lookupModelPricing: (modelId: string) => ModelPricing | null,
	kagiCostPer1000Searches: number,
): CostBreakdown {
	let llmTotal = 0;
	let llmAny = false;
	let webSearchTotal = 0;
	for (const m of messages) {
		if (m.role !== 'assistant') continue;
		const usage = m.meta?.usage ?? null;
		const model = m.model ? lookupModelPricing(m.model) : null;
		const webSearchCount = countWebSearches(m.parts);
		const cost = computeCost({ usage, model, webSearchCount, kagiCostPer1000Searches });
		if (cost.llmCost != null) {
			llmAny = true;
			llmTotal += cost.llmCost;
		}
		webSearchTotal += cost.webSearchCost;
	}
	const llmCost = llmAny ? llmTotal : null;
	const total =
		!llmAny && webSearchTotal === 0 ? null : (llmAny ? llmTotal : 0) + webSearchTotal;
	return { llmCost, webSearchCost: webSearchTotal, total };
}

// Count tool_use parts whose name matches a web-search tool. The default
// tool registry exposes Kagi search as `web_search`; sub-agent registries
// can rename it but we accept `web_search` as the canonical id since that's
// what the assistant calls in practice. Pass `extraNames` to count
// additional tool names (e.g. test fixtures).
export function countWebSearches(
	parts: MessagePart[] | null | undefined,
	extraNames: readonly string[] = [],
): number {
	if (!parts || parts.length === 0) return 0;
	const names = new Set<string>(['web_search', ...extraNames]);
	let count = 0;
	for (const p of parts) {
		if (p.type === 'tool_use' && names.has(p.name)) count += 1;
	}
	return count;
}
