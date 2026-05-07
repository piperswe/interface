<script lang="ts">
	import type { ToolResultPart } from '$lib/types/conversation';
	import type { Bundle } from './parts';
	import MessagePart from './MessagePart.svelte';
	import { ChevronRight } from 'lucide-svelte';

	let {
		group,
		isStreaming,
		results,
		lastIndex,
	}: {
		group: Bundle;
		isStreaming: boolean;
		results: Map<string, ToolResultPart>;
		lastIndex: number;
	} = $props();
</script>

<details class="work-bundle" open={group.isLast && isStreaming}>
	<summary>
		<ChevronRight class="chevron" size={12} aria-hidden="true" />
		<span class="work-bundle-label">{group.mixed ? 'Tools & thinking' : 'Thinking'}</span>
		{#if group.hasActive}<span class="streaming-indicator" aria-hidden="true">●</span>{/if}
	</summary>
	<div class="work-bundle-body">
		{#each group.parts as item (item.index)}
			<MessagePart
				part={item.part}
				index={item.index}
				{lastIndex}
				{isStreaming}
				{results}
				nested={true}
			/>
		{/each}
	</div>
</details>

<style>
	.work-bundle {
		border: 1px solid var(--border-soft);
		border-radius: var(--bs-border-radius);
		background: var(--bs-body-bg);
		font-size: 0.88em;
		margin: 0.25rem 0;
	}

	.work-bundle summary {
		cursor: pointer;
		list-style: none;
		padding: 0.4rem 0.65rem;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--muted);
		user-select: none;
	}

	.work-bundle summary::-webkit-details-marker,
	.work-bundle summary::marker {
		display: none;
		content: '';
	}

	.work-bundle summary :global(.chevron) {
		color: var(--muted-2);
		transition: transform 100ms ease;
		flex-shrink: 0;
	}

	.work-bundle[open] summary :global(.chevron) {
		transform: rotate(90deg);
	}

	.work-bundle summary:hover {
		color: var(--fg);
	}

	.work-bundle-label {
		font-weight: 500;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.work-bundle-body {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.3rem 0.5rem;
	}
</style>
