<script lang="ts">
	import type { MetaSnapshot } from '$lib/types/conversation';
	import { fmtCost, fmtMs, fmtNumber, fmtThroughput } from '$lib/formatters';

	let { snapshot }: { snapshot: MetaSnapshot | null } = $props();

	const ttftMs = $derived(snapshot && snapshot.firstTokenAt && snapshot.startedAt ? snapshot.firstTokenAt - snapshot.startedAt : 0);
</script>

{#if snapshot}
	<details class="meta-panel small text-muted">
		<summary aria-label="Request metadata" title="Request metadata">
			<span class="meta-panel-icon" aria-hidden="true">ⓘ</span>
		</summary>
		<dl class="d-grid" style="grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem">
			<dt>Model</dt>
			<dd>{snapshot.generation?.model ?? snapshot.lastChunk?.model ?? '—'}</dd>
			<dt>ID</dt>
			<dd>{snapshot.lastChunk?.id ?? '—'}</dd>
			<dt>Service tier</dt>
			<dd>{snapshot.lastChunk?.serviceTier ?? '—'}</dd>
			<dt>Prompt tokens</dt>
			<dd>{fmtNumber(snapshot.generation?.tokensPrompt ?? snapshot.usage?.promptTokens)}</dd>
			<dt>Completion tokens</dt>
			<dd>{fmtNumber(snapshot.generation?.tokensCompletion ?? snapshot.usage?.completionTokens)}</dd>
			<dt>Total tokens</dt>
			<dd>{fmtNumber(snapshot.usage?.totalTokens)}</dd>
			<dt>Cached tokens</dt>
			<dd>{fmtNumber(snapshot.generation?.nativeTokensCached ?? snapshot.usage?.promptTokensDetails?.cachedTokens)}</dd>
			<dt>Reasoning tokens</dt>
			<dd>{fmtNumber(snapshot.generation?.nativeTokensReasoning ?? snapshot.usage?.completionTokensDetails?.reasoningTokens)}</dd>
			<dt>Cost</dt>
			<dd>{fmtCost(snapshot.generation?.totalCost ?? snapshot.usage?.cost)}</dd>
			<dt>Time to first token</dt>
			<dd>{fmtMs(ttftMs)}</dd>
			<dt>Total time</dt>
			<dd>{fmtMs(snapshot.generation?.latency ?? 0)}</dd>
			<dt>Throughput</dt>
			<dd>{fmtThroughput(snapshot.generation?.tokensCompletion ?? undefined, snapshot.generation?.generationTime ?? 0)}</dd>
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
