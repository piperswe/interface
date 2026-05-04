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

<details class="tool-call border rounded overflow-hidden bg-body small{nested ? ' nested' : ''}" data-tool-name={call.name} {open}>
	<summary class="d-flex align-items-center gap-2 p-2">
		<span class="tool-call-name font-monospace fw-semibold">{call.name}</span>
		{#if pending}
			<span class="tool-call-status pending ms-auto d-flex align-items-center gap-1">
				running<span class="streaming-indicator" aria-hidden="true">●</span>
			</span>
		{:else if result?.isError}
			<span class="tool-call-status error ms-auto">error</span>
		{:else if result?.streaming}
			<span class="tool-call-status pending ms-auto d-flex align-items-center gap-1">
				streaming<span class="streaming-indicator" aria-hidden="true">●</span>
			</span>
		{:else}
			<span class="tool-call-status ok ms-auto">done</span>
		{/if}
	</summary>
	<div class="tool-call-body d-flex flex-column gap-2 p-2">
		<div class="tool-call-input">
			<div class="tool-call-label">Input</div>
			<pre class="m-0 rounded p-2" style="font-size: 0.85em"><code>{JSON.stringify(call.input ?? {}, null, 2)}</code></pre>
		</div>
		{#if result}
			<div class="tool-call-result">
				<div class="tool-call-label">Result</div>
				<pre class="m-0 rounded p-2" style="font-size: 0.85em"><code>{result.content}</code></pre>
			</div>
		{:else}
			<div class="tool-call-result pending text-muted fst-italic">running…</div>
		{/if}
	</div>
</details>

<style>
	.tool-call {
		font-size: 0.9em;
	}

	.tool-call summary {
		cursor: pointer;
		list-style: none;
	}

	.tool-call summary::-webkit-details-marker,
	.tool-call summary::marker {
		display: none;
		content: '';
	}

	.tool-call[open] summary {
		border-bottom: 1px solid var(--border-soft);
	}

	.tool-call-name {
		color: var(--accent);
	}

	.tool-call-status {
		font-size: 0.7em;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.tool-call-status.error {
		color: var(--error-fg);
	}

	.tool-call-status.pending {
		color: var(--accent);
	}

	.tool-call-status.ok {
		color: var(--muted-2);
	}

	.tool-call pre {
		background: var(--code-block-bg);
		color: var(--code-block-fg);
		overflow-x: auto;
	}

	.tool-call-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin-bottom: 0.2rem;
	}

	.nested {
		border: none;
		margin-left: 0.5rem;
	}

	.nested summary {
		padding-left: 0.5rem;
	}
</style>
