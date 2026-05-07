<script lang="ts">
	import { onMount } from 'svelte';
	import { Folder, FileText, FileArchive, Download, X, ArrowUp } from 'lucide-svelte';

	const _markdownMod = import('$lib/markdown.client');

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
	let fileContentHtml = $state<string | null>(null);
	let fileLoading = $state(false);
	let viewSeq = 0;

	const EXT_LANG: Record<string, string> = {
		ts: 'typescript',
		tsx: 'tsx',
		js: 'javascript',
		mjs: 'javascript',
		cjs: 'javascript',
		jsx: 'jsx',
		py: 'python',
		rs: 'rust',
		sql: 'sql',
		sh: 'bash',
		bash: 'bash',
		env: 'bash',
		json: 'json',
		yaml: 'yaml',
		yml: 'yaml',
		md: 'markdown',
		markdown: 'markdown',
		html: 'html',
		svg: 'html',
		xml: 'html',
		css: 'css',
	};

	function langForPath(path: string): string {
		const ext = path.split('.').pop()?.toLowerCase() ?? '';
		return EXT_LANG[ext] ?? 'text';
	}

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
		const mySeq = ++viewSeq;
		selectedFile = path;
		fileContent = null;
		fileContentHtml = null;
		fileLoading = true;
		try {
			const res = await fetch(`/c/${conversationId}/sandbox/file?path=${encodeURIComponent(path)}`);
			if (!res.ok) throw new Error(await res.text());
			const text = await res.text();
			if (mySeq !== viewSeq) return;
			fileContent = text;
			try {
				const mod = await _markdownMod;
				const html = await mod.renderArtifactCodeClient(text, langForPath(path));
				if (mySeq !== viewSeq) return;
				fileContentHtml = html;
			} catch {
				// Fall back to the plain <pre><code> rendering below.
			}
		} catch (e) {
			if (mySeq !== viewSeq) return;
			fileContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			if (mySeq === viewSeq) fileLoading = false;
		}
	}

	function closeViewer() {
		viewSeq++;
		selectedFile = null;
		fileContent = null;
		fileContentHtml = null;
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
		<button type="button" class="btn btn-sm btn-ghost d-inline-flex align-items-center" onclick={navigateUp} disabled={currentPath === '/'} title="Go up" aria-label="Go up"><ArrowUp size={14} aria-hidden="true" /></button>
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
							class="directory-link text-start border-0 bg-transparent small flex-fill text-truncate d-inline-flex align-items-center gap-2"
							onclick={() => loadFiles(node.path)}
						>
							<Folder size={14} aria-hidden="true" />
							<span class="text-truncate">{node.path.split('/').pop()}</span>
						</button>
					{:else}
						<button
							type="button"
							class="file-link text-start border-0 bg-transparent small flex-fill text-truncate d-inline-flex align-items-center gap-2"
							onclick={() => isTextFile(node.path) ? viewFile(node.path) : null}
							disabled={!isTextFile(node.path)}
							title={isTextFile(node.path) ? 'View file' : 'Binary file — download only'}
						>
							{#if isTextFile(node.path)}
								<FileText size={14} aria-hidden="true" />
							{:else}
								<FileArchive size={14} aria-hidden="true" />
							{/if}
							<span class="text-truncate">{node.path.split('/').pop()}</span>
						</button>
						<a
							href="/c/{conversationId}/sandbox/file?path={encodeURIComponent(node.path)}&download=1"
							class="download-link small text-decoration-none d-inline-flex align-items-center"
							download
							aria-label="Download {node.path.split('/').pop()}"
							title="Download"
						>
							<Download size={14} aria-hidden="true" />
						</a>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
	{#if selectedFile}
		<div class="file-viewer flex-shrink-0 border-top">
			<div class="file-viewer-header d-flex align-items-center justify-content-between px-2 py-1 border-bottom small">
				<span class="text-truncate">{selectedFile.split('/').pop()}</span>
				<button type="button" class="btn btn-sm btn-ghost d-inline-flex align-items-center" onclick={closeViewer} aria-label="Close file viewer" title="Close"><X size={14} aria-hidden="true" /></button>
			</div>
			<div class="file-viewer-body overflow-auto">
				{#if fileLoading}
					<div class="p-2 small text-muted">Loading…</div>
				{:else if fileContentHtml !== null}
					<div class="shiki-block">{@html fileContentHtml}</div>
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

	.shiki-block :global(pre.shiki) {
		margin: 0;
		padding: 0.5rem 0.6rem;
		font-size: 0.82em;
		overflow-x: auto;
		background: transparent;
	}

	.shiki-block :global(pre.shiki code) {
		background: none;
		padding: 0;
		font-size: inherit;
	}
</style>
