<script lang="ts">
	import { RotateCcw } from 'lucide-svelte';
	import { onDestroy, onMount } from 'svelte';
	import { getSandboxPreviewPorts } from '$lib/sandbox.remote';

	let {
		conversationId,
	}: {
		conversationId: string;
	} = $props();

	let ports = $state<{ port: number; url: string; name?: string }[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let selectedPort = $state<number | null>(null);
	let refreshInterval: ReturnType<typeof setInterval> | null = null;

	async function loadPorts() {
		loading = true;
		error = null;
		try {
			const result = await getSandboxPreviewPorts(conversationId);
			ports = result.ports;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadPorts();
		refreshInterval = setInterval(loadPorts, 5000);
	});

	onDestroy(() => {
		if (refreshInterval) clearInterval(refreshInterval);
	});
</script>

<div class="preview-tab d-flex flex-column h-100">
	<div class="preview-header d-flex align-items-center justify-content-between px-2 py-1 border-bottom">
		<span class="small fw-medium">Preview ports</span>
		<button type="button" class="btn btn-sm btn-ghost d-inline-flex align-items-center" onclick={loadPorts} title="Refresh" aria-label="Refresh"><RotateCcw size={14} aria-hidden="true" /></button>
	</div>
	<div class="ports-list flex-shrink-0 border-bottom">
		{#if loading && ports.length === 0}
			<div class="p-2 small text-muted">Loading…</div>
		{:else if error}
			<div class="p-2 small text-danger">{error}</div>
		{:else if ports.length === 0}
			<div class="p-2 small text-muted">No exposed ports. Start a dev server in the sandbox to see previews here.</div>
		{:else}
			{#each ports as p (p.port)}
				<button
					type="button"
					class="port-item d-flex align-items-center gap-2 px-2 py-1 text-start border-0 bg-transparent w-100"
					class:active={selectedPort === p.port}
					onclick={() => selectedPort = p.port}
				>
					<span class="port-number small font-monospace">:{p.port}</span>
					<span class="port-name small text-truncate">{p.name ?? 'Untitled'}</span>
				</button>
			{/each}
		{/if}
	</div>
	<div class="preview-frame flex-fill">
		{#if selectedPort}
			<!--
				The preview is served from the same origin as the app, so
				`allow-same-origin + allow-scripts` would defeat the sandbox
				entirely — user-supplied dev-server code could reach
				`window.parent`, document.cookie, and the operator's session.
				Drop `allow-same-origin` so the iframe is treated as an opaque
				origin; the previewed app can still execute scripts inside the
				frame, just without access to ours.
			-->
			<iframe
				title="Sandbox preview"
				src="/c/{conversationId}/preview/{selectedPort}/"
				class="preview-iframe"
				sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
			></iframe>
		{:else}
			<div class="empty p-3 small text-muted text-center">Select a port to preview the running service.</div>
		{/if}
	</div>
</div>

<style>
	.preview-header {
		min-height: 36px;
		background: var(--bs-body-bg);
	}

	.ports-list {
		max-height: 35%;
		overflow-y: auto;
	}

	.port-item {
		cursor: pointer;
		transition: background 100ms ease;
		min-height: 32px;
	}

	.port-item:hover,
	.port-item.active {
		background: var(--bs-secondary-bg);
	}

	.port-number {
		color: var(--accent);
		flex-shrink: 0;
	}

	.port-name {
		color: var(--fg);
		flex: 1;
		min-width: 0;
	}

	.preview-frame {
		min-height: 0;
		position: relative;
	}

	.preview-iframe {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: none;
		background: #fff;
	}

	.empty {
		font-style: italic;
	}
</style>
