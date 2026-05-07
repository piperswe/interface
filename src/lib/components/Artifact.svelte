<script lang="ts">
	import type { Artifact } from '$lib/types/conversation';
	import { ArrowRight } from 'lucide-svelte';

	let {
		artifact,
		onSelect,
	}: {
		artifact: Artifact;
		onSelect?: (id: string) => void;
	} = $props();

	const showHtml = $derived(
		typeof artifact.contentHtml === 'string' && artifact.contentHtml.length > 0,
	);
	const hasInlinePreview = $derived(
		artifact.type === 'code' || artifact.type === 'markdown' || artifact.type === 'svg',
	);
</script>

<div
	class="artifact border rounded overflow-hidden bg-body"
	data-artifact-id={artifact.id}
	data-type={artifact.type}
>
	<button
		type="button"
		class="artifact-header d-flex flex-wrap align-items-center gap-2 p-2 bg-body-secondary border-bottom small w-100 text-start border-0"
		onclick={() => onSelect?.(artifact.id)}
		disabled={!onSelect}
	>
		<span class="artifact-type">{artifact.type}</span>
		{#if artifact.name}<span class="artifact-name">{artifact.name}</span>{/if}
		{#if artifact.language}<span class="artifact-lang">{artifact.language}</span>{/if}
		{#if artifact.version > 1}<span class="artifact-version">v{artifact.version}</span>{/if}
		{#if onSelect}<span class="artifact-action ms-auto small text-muted d-inline-flex align-items-center gap-1">View <ArrowRight size={12} aria-hidden="true" /></span>{/if}
	</button>
	{#if hasInlinePreview && showHtml}
		<div class="artifact-body">{@html artifact.contentHtml}</div>
	{:else if hasInlinePreview}
		<pre class="artifact-body m-0"><code>{artifact.content}</code></pre>
	{/if}
</div>

<style>
	.artifact-header {
		cursor: pointer;
		transition: background 100ms ease;
	}

	.artifact-header:hover:not([disabled]) {
		background: var(--bs-tertiary-bg);
	}

	.artifact-header:disabled {
		cursor: default;
	}

	.artifact-type {
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--accent);
	}

	.artifact-name {
		color: var(--fg);
	}

	.artifact-lang,
	.artifact-version {
		color: var(--muted);
	}

	.artifact-action {
		opacity: 0;
		transition: opacity 100ms ease;
	}

	.artifact-header:hover:not([disabled]) .artifact-action {
		opacity: 1;
	}

	.artifact-body :global(pre),
	.artifact-body :global(pre.shiki) {
		margin: 0;
		border-radius: 0;
	}

	.artifact-body > *:first-child {
		margin-top: 0.5rem;
	}

	.artifact-body > *:last-child {
		margin-bottom: 0.5rem;
	}
</style>
