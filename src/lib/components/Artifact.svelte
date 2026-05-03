<script lang="ts">
	import type { Artifact } from '$lib/types/conversation';

	let { artifact }: { artifact: Artifact } = $props();

	const showHtml = $derived(typeof artifact.contentHtml === 'string' && artifact.contentHtml.length > 0);
</script>

<div class="artifact border rounded overflow-hidden bg-body" data-artifact-id={artifact.id} data-type={artifact.type}>
	<div class="artifact-header d-flex flex-wrap align-items-center gap-2 p-2 bg-body-secondary border-bottom small">
		<span class="artifact-type">{artifact.type}</span>
		{#if artifact.name}<span class="artifact-name">{artifact.name}</span>{/if}
		{#if artifact.language}<span class="artifact-lang">{artifact.language}</span>{/if}
		{#if artifact.version > 1}<span class="artifact-version">v{artifact.version}</span>{/if}
	</div>
	{#if showHtml}
		<div class="artifact-body">{@html artifact.contentHtml}</div>
	{:else}
		<pre class="artifact-body m-0"><code>{artifact.content}</code></pre>
	{/if}
</div>

<style>
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
