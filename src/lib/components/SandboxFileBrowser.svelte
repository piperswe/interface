<script lang="ts">
	import { onMount } from 'svelte';

	let {
		conversationId,
	}: {
		conversationId: string;
	} = $props();

	type FileNode = { path: string; type: 'file' | 'directory' };

	let files = $state<FileNode[]>([]);
	let currentPath = $state('/workspace');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let selectedFile = $state<string | null>(null);
	let fileContent = $state<string | null>(null);
	let fileLoading = $state(false);

	async function loadFiles(path: string) {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/c/${conversationId}/sandbox/files?path=${encodeURIComponent(path)}`);
			if (!res.ok) throw new Error(await res.text());
			files = await res.json();
			currentPath = path;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function viewFile(path: string) {
		selectedFile = path;
		fileContent = null;
		fileLoading = true;
		try {
			const res = await fetch(`/c/${conversationId}/sandbox/file?path=${encodeURIComponent(path)}`);
			if (!res.ok) throw new Error(await res.text());
			fileContent = await res.text();
		} catch (e) {
			fileContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			fileLoading = false;
		}
	}

	function navigateUp() {
		const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
		loadFiles(parent);
	}

	onMount(() => {
		loadFiles('/workspace');
	});

	const isTextFile = $derived((path: string) => {
		const ext = path.split('.').pop()?.toLowerCase() ?? '';
		const textExts = ['txt','md','js','ts','jsx','tsx','json','html','css','svg','xml','yaml','yml','py','sh','csv','log','ini','toml','env','gitignore','dockerfile'];
		return textExts.includes(ext) || !ext;
	});
</script>

<div class="files-tab d-flex flex-column h-100">
	<div class="files-header d-flex align-items-center gap-2 px-2 py-1 border-bottom">
		<button type="button" class="btn btn-sm btn-ghost" onclick={navigateUp} disabled={currentPath === '/'} title="Go up">↑</button>
		<span class="current-path small text-truncate">{currentPath}</span>
	</div>
	<div class="files-list flex-fill overflow-auto">
		{#if loading}
			<div class="p-2 small text-muted">Loading…</div>
		{:else if error}
			<div class="p-2 small text-danger">{error}</div>
		{:else if files.length === 0}
			<div class="p-2 small text-muted">No files found.</div>
		{:else}
			{#each files as node (node.path)}
				<div class="file-node d-flex align-items-center gap-2 px-2 py-1">
					{#if node.type === 'directory'}
						<button
							type="button"
							class="directory-link text-start border-0 bg-transparent small flex-fill text-truncate"
							onclick={() => loadFiles(node.path)}
						>
							📁 {node.path.split('/').pop()}
						</button>
					{:else}
						<button
							type="button"
							class="file-link text-start border-0 bg-transparent small flex-fill text-truncate"
							onclick={() => isTextFile(node.path) ? viewFile(node.path) : null}
							disabled={!isTextFile(node.path)}
							title={isTextFile(node.path) ? 'View file' : 'Binary file — download only'}
						>
							{isTextFile(node.path) ? '📄' : '📦'} {node.path.split('/').pop()}
						</button>
						<a
							href="/c/{conversationId}/sandbox/file?path={encodeURIComponent(node.path)}&download=1"
							class="download-link small text-decoration-none"
							download
						>⬇</a>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
	{#if selectedFile}
		<div class="file-viewer flex-shrink-0 border-top">
			<div class="file-viewer-header d-flex align-items-center justify-content-between px-2 py-1 border-bottom small">
				<span class="text-truncate">{selectedFile.split('/').pop()}</span>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => { selectedFile = null; fileContent = null; }}>✕</button>
			</div>
			<div class="file-viewer-body overflow-auto">
				{#if fileLoading}
					<div class="p-2 small text-muted">Loading…</div>
				{:else if fileContent !== null}
					<pre class="m-0 p-2 small"><code>{fileContent}</code></pre>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.files-header {
		min-height: 36px;
		background: var(--bs-body-bg);
	}

	.current-path {
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		color: var(--muted);
	}

	.file-node {
		transition: background 100ms ease;
	}

	.file-node:hover {
		background: var(--bs-secondary-bg);
	}

	.directory-link,
	.file-link {
		color: var(--fg);
		cursor: pointer;
		padding: 0;
	}

	.file-link:disabled {
		color: var(--muted-2);
		cursor: not-allowed;
		opacity: 0.7;
	}

	.download-link {
		color: var(--accent);
		padding: 0 0.25rem;
	}

	.file-viewer {
		max-height: 50%;
		display: flex;
		flex-direction: column;
	}

	.file-viewer-header {
		min-height: 32px;
		background: var(--bs-secondary-bg);
	}

	.file-viewer-body {
		flex: 1 1 auto;
		min-height: 0;
		background: var(--code-block-bg);
	}

	.file-viewer-body pre {
		background: transparent;
		color: var(--code-block-fg);
	}
</style>
