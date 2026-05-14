<script lang="ts">
	import { ChevronRight } from 'lucide-svelte';
	import type { ThinkingPart } from '$lib/types/conversation';

	let { part, nested }: { part: ThinkingPart; nested: boolean } = $props();
</script>

{#if part.text}
	<details class="thinking{nested ? ' nested' : ''}">
		<summary>
			<ChevronRight class="chevron" size={12} aria-hidden="true" />
			<span class="thinking-label">Thinking</span>
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

	details.thinking summary :global(.chevron) {
		color: var(--muted-2);
		transition: transform 100ms ease;
		flex-shrink: 0;
	}

	details.thinking[open] summary :global(.chevron) {
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
