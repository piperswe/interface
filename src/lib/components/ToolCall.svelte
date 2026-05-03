<script lang="ts">
	import type { ToolCallRecord, ToolResultRecord } from '$lib/types/conversation';

	let {
		call,
		result,
		defaultOpen = false,
		nested = false,
	}: {
		call: ToolCallRecord;
		result?: ToolResultRecord;
		defaultOpen?: boolean;
		nested?: boolean;
	} = $props();

	const pending = $derived(!result);
	const open = $derived(pending || defaultOpen);
</script>

<details class="tool-call{nested ? ' nested' : ''}" data-tool-name={call.name} {open}>
	<summary>
		<span class="tool-call-name">{call.name}</span>
		{#if pending}
			<span class="tool-call-status pending">
				running<span class="streaming-indicator" aria-hidden="true">●</span>
			</span>
		{:else if result?.isError}
			<span class="tool-call-status error">error</span>
		{:else}
			<span class="tool-call-status ok">done</span>
		{/if}
	</summary>
	<div class="tool-call-body">
		<div class="tool-call-input">
			<div class="tool-call-label">Input</div>
			<pre><code>{JSON.stringify(call.input ?? {}, null, 2)}</code></pre>
		</div>
		{#if result}
			<div class="tool-call-result">
				<div class="tool-call-label">Result</div>
				<pre><code>{result.content}</code></pre>
			</div>
		{:else}
			<div class="tool-call-result pending">running…</div>
		{/if}
	</div>
</details>
