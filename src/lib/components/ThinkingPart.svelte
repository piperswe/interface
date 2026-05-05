<script lang="ts">
	import type { ThinkingPart } from '$lib/types/conversation';

	let {
		part,
		isCurrent,
		nested,
	}: { part: ThinkingPart; isCurrent: boolean; nested: boolean } = $props();
</script>

{#if part.text}
	<details class="thinking{nested ? ' nested' : ''}" open={isCurrent}>
		<summary>
			<span class="thinking-label">Thinking</span>
			{#if isCurrent}<span class="streaming-indicator" aria-hidden="true">●</span>{/if}
		</summary>
		{#if part.textHtml}
			<div class="thinking-body">{@html part.textHtml}</div>
		{:else}
			<div class="thinking-body" style="white-space: pre-wrap">{part.text}</div>
		{/if}
	</details>
{/if}

<style>
	details.thinking {
		border-left: 2px solid var(--border-soft);
		padding: 0.1rem 0 0.1rem 0.75rem;
		color: var(--muted);
		font-size: 0.92em;
	}

	details.thinking summary {
		cursor: pointer;
		padding: 0.2rem 0;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--muted);
		list-style: none;
		font-style: italic;
	}

	details.thinking summary::-webkit-details-marker,
	details.thinking summary::marker {
		display: none;
		content: '';
	}

	details.thinking summary::before {
		content: '▸';
		font-size: 0.7em;
		color: var(--muted-2);
		transition: transform 100ms ease;
		display: inline-block;
	}

	details.thinking[open] summary::before {
		transform: rotate(90deg);
	}

	.thinking-label {
		font-weight: 500;
	}

	.thinking-body {
		padding: 0.3rem 0;
		color: var(--muted);
	}

	.thinking-body :global(p:first-child) {
		margin-top: 0;
	}

	.thinking-body :global(p:last-child) {
		margin-bottom: 0;
	}

	details.thinking.nested {
		padding-left: 0.35rem;
	}
</style>
