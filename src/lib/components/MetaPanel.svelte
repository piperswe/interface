<script lang="ts">
	import type { MetaSnapshot } from '$lib/types/conversation';
	import { fmtCost, fmtMs, fmtNumber, fmtThroughput } from '$lib/formatters';

	let { snapshot }: { snapshot: MetaSnapshot | null } = $props();

	const ttftMs = $derived(snapshot && snapshot.firstTokenAt && snapshot.startedAt ? snapshot.firstTokenAt - snapshot.startedAt : 0);
</script>

{#if snapshot}
	<details class="meta-panel">
		<summary aria-label="Request metadata" title="Request metadata">
			<span class="meta-panel-icon" aria-hidden="true">ⓘ</span>
		</summary>
		<dl>
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
