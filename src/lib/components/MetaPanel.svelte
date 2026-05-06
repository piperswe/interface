<script lang="ts">
	import type { MessagePart, MetaSnapshot } from '$lib/types/conversation';
	import { fmtMs, fmtNumber } from '$lib/formatters';
	import { computeCost, countWebSearches } from '$lib/cost';

	let {
		snapshot,
		modelPricing = null,
		parts = null,
		kagiCostPer1000Searches = 25,
	}: {
		snapshot: MetaSnapshot | null;
		modelPricing?: {
			inputCostPerMillionTokens: number | null;
			outputCostPerMillionTokens: number | null;
		} | null;
		parts?: MessagePart[] | null;
		kagiCostPer1000Searches?: number;
	} = $props();

	const ttftMs = $derived(snapshot && snapshot.firstTokenAt && snapshot.startedAt ? snapshot.firstTokenAt - snapshot.startedAt : 0);
	const webSearchCount = $derived(countWebSearches(parts));
	const cost = $derived(
		computeCost({
			usage: snapshot?.usage ?? null,
			model: modelPricing,
			webSearchCount,
			kagiCostPer1000Searches,
		}),
	);

	function fmtUsd(value: number): string {
		if (value === 0) return '$0.00';
		// 4 fractional digits below $1, 2 above. Anything below 0.0001 collapses
		// to "<$0.0001" so it doesn't render as "$0.0000".
		if (value > 0 && value < 0.0001) return '<$0.0001';
		const digits = value < 1 ? 4 : 2;
		return '$' + value.toFixed(digits);
	}
</script>

{#if snapshot}
	<details class="meta-panel small text-muted">
		<summary aria-label="Request metadata" title="Request metadata">
			<span class="meta-panel-icon" aria-hidden="true">ⓘ</span>
		</summary>
		<dl class="d-grid" style="grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem">
			<dt>Input tokens</dt>
			<dd>{fmtNumber(snapshot.usage?.inputTokens)}</dd>
			<dt>Output tokens</dt>
			<dd>{fmtNumber(snapshot.usage?.outputTokens)}</dd>
			<dt>Total tokens</dt>
			<dd>{fmtNumber(snapshot.usage?.totalTokens)}</dd>
			{#if snapshot.usage?.cacheReadInputTokens != null}
				<dt>Cached tokens</dt>
				<dd>{fmtNumber(snapshot.usage.cacheReadInputTokens)}</dd>
			{/if}
			{#if snapshot.usage?.cacheCreationInputTokens != null}
				<dt>Cache writes</dt>
				<dd>{fmtNumber(snapshot.usage.cacheCreationInputTokens)}</dd>
			{/if}
			{#if snapshot.usage?.thinkingTokens != null}
				<dt>Reasoning tokens</dt>
				<dd>{fmtNumber(snapshot.usage.thinkingTokens)}</dd>
			{/if}
			<dt>Time to first token</dt>
			<dd>{fmtMs(ttftMs)}</dd>
			{#if cost.total != null}
				<dt>Cost</dt>
				<dd>{fmtUsd(cost.total)}</dd>
			{/if}
			{#if webSearchCount > 0}
				<dt>Web searches</dt>
				<dd>
					{fmtNumber(webSearchCount)}{cost.webSearchCost > 0
						? ` (${fmtUsd(cost.webSearchCost)})`
						: ''}
				</dd>
			{/if}
		</dl>
	</details>
{/if}

<style>
	.meta-panel {
		margin-top: 0.5rem;
		font-size: 0.78rem;
	}

	.meta-panel > summary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border-radius: 999px;
		color: var(--muted-2);
		cursor: pointer;
		list-style: none;
		user-select: none;
		transition: color 120ms ease, background 120ms ease;
	}

	.meta-panel > summary::-webkit-details-marker,
	.meta-panel > summary::marker {
		display: none;
		content: '';
	}

	.meta-panel > summary:hover,
	.meta-panel[open] > summary {
		color: var(--accent);
		background: var(--accent-soft);
	}

	.meta-panel-icon {
		font-size: 1rem;
		line-height: 1;
	}

	.meta-panel[open] {
		margin-top: 0.5rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-soft);
		border-radius: var(--bs-border-radius);
		background: var(--bs-secondary-bg);
	}

	.meta-panel[open] > summary {
		margin-bottom: 0.4rem;
		background: transparent;
	}

	.meta-panel dl {
		margin: 0;
	}

	.meta-panel dt {
		color: var(--muted);
	}

	.meta-panel dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
		color: var(--fg);
	}
</style>
