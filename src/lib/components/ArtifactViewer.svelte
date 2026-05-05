<script lang="ts">
	import type { Artifact } from '$lib/types/conversation';

	let {
		artifact,
	}: {
		artifact: Artifact;
	} = $props();

	let mermaidSvg = $state<string | null>(null);
	let mermaidError = $state<string | null>(null);

	$effect(() => {
		if (artifact.type === 'mermaid') {
			renderMermaid(artifact.content);
		} else {
			mermaidSvg = null;
			mermaidError = null;
		}
	});

	async function renderMermaid(content: string) {
		try {
			const mod = await import('mermaid');
			const mermaid = mod.default ?? mod;
			await mermaid.initialize({ startOnLoad: false, theme: 'default' });
			const { svg } = await mermaid.render(`mermaid-${artifact.id}`, content);
			mermaidSvg = svg;
			mermaidError = null;
		} catch (e) {
			mermaidSvg = null;
			mermaidError = e instanceof Error ? e.message : String(e);
		}
	}
</script>

{#if artifact.type === 'html'}
	<iframe
		sandbox="allow-scripts"
		title={artifact.name ?? 'HTML artifact'}
		srcdoc={artifact.content}
		class="artifact-html-frame"
	></iframe>
{:else if artifact.type === 'svg'}
	<div class="artifact-svg">{@html artifact.content}</div>
{:else if artifact.type === 'mermaid'}
	{#if mermaidSvg}
		<div class="artifact-mermaid">{@html mermaidSvg}</div>
	{:else if mermaidError}
		<div class="artifact-error small">Mermaid error: {mermaidError}</div>
	{:else}
		<div class="artifact-loading small text-muted">Rendering diagram…</div>
	{/if}
{:else if artifact.type === 'code' || artifact.type === 'markdown'}
	{#if artifact.contentHtml}
		<div class="artifact-html">{@html artifact.contentHtml}</div>
	{:else}
		<pre class="m-0"><code>{artifact.content}</code></pre>
	{/if}
{/if}

<style>
	.artifact-html-frame {
		width: 100%;
		height: 100%;
		min-height: 280px;
		border: none;
		background: #fff;
	}

	.artifact-svg,
	.artifact-mermaid,
	.artifact-html {
		padding: 0.5rem;
	}

	.artifact-svg :global(svg) {
		max-width: 100%;
		height: auto;
	}

	.artifact-mermaid :global(svg) {
		max-width: 100%;
		height: auto;
		display: block;
		margin: 0 auto;
	}

	.artifact-error {
		color: var(--error-fg);
		background: var(--error-bg);
		padding: 0.5rem;
		border-radius: var(--bs-border-radius);
	}

	.artifact-loading {
		padding: 1rem;
		text-align: center;
	}

	.artifact-html :global(pre),
	.artifact-html :global(pre.shiki) {
		margin: 0;
		border-radius: 0;
	}
</style>
