<script lang="ts">
	import type { Artifact } from '$lib/types/conversation';

	let { artifact }: { artifact: Artifact } = $props();

	const showHtml = $derived(typeof artifact.contentHtml === 'string' && artifact.contentHtml.length > 0);
</script>

<div class="artifact" data-artifact-id={artifact.id} data-type={artifact.type}>
	<div class="artifact-header">
		<span class="artifact-type">{artifact.type}</span>
		{#if artifact.name}<span class="artifact-name">{artifact.name}</span>{/if}
		{#if artifact.language}<span class="artifact-lang">{artifact.language}</span>{/if}
		{#if artifact.version > 1}<span class="artifact-version">v{artifact.version}</span>{/if}
	</div>
	{#if showHtml}
		<div class="artifact-body">{@html artifact.contentHtml}</div>
	{:else}
		<pre class="artifact-body"><code>{artifact.content}</code></pre>
	{/if}
</div>
