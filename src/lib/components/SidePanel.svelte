<script lang="ts">
	import type { Artifact } from '$lib/types/conversation';
	import SidePanelArtifacts from './SidePanelArtifacts.svelte';
	import SandboxFileBrowser from './SandboxFileBrowser.svelte';
	import SandboxPreview from './SandboxPreview.svelte';

	let {
		conversationId,
		artifacts = [],
		tab = 'artifacts',
		selectedArtifactId = null,
		onClose,
		onTabChange,
		onSelectArtifact,
	}: {
		conversationId: string;
		artifacts: Artifact[];
		tab: 'artifacts' | 'files' | 'preview';
		selectedArtifactId: string | null;
		onClose: () => void;
		onTabChange: (tab: 'artifacts' | 'files' | 'preview') => void;
		onSelectArtifact: (id: string) => void;
	} = $props();

	const tabs = $derived([
		{ key: 'artifacts' as const, label: `Artifacts (${artifacts.length})` },
		{ key: 'files' as const, label: 'Files' },
		{ key: 'preview' as const, label: 'Preview' },
	]);
</script>

<div class="side-panel d-flex flex-column h-100 bg-body border-start">
	<div class="side-panel-header d-flex align-items-center border-bottom">
		<div class="tabs d-flex flex-fill" role="tablist" aria-label="Side panel sections">
			{#each tabs as t (t.key)}
				<button
					type="button"
					class="tab-btn small px-2 py-2 border-0 bg-transparent"
					class:active={tab === t.key}
					onclick={() => onTabChange(t.key)}
					role="tab"
					aria-selected={tab === t.key}
					aria-controls="side-panel-body"
					id={`side-panel-tab-${t.key}`}
				>
					{t.label}
				</button>
			{/each}
		</div>
		<button type="button" class="close-btn btn btn-sm btn-ghost" onclick={onClose} aria-label="Close panel">✕</button>
	</div>
	<div
		class="side-panel-body flex-fill overflow-hidden"
		id="side-panel-body"
		role="tabpanel"
		aria-labelledby={`side-panel-tab-${tab}`}
	>
		{#if tab === 'artifacts'}
			<SidePanelArtifacts {artifacts} selectedId={selectedArtifactId} onSelect={onSelectArtifact} />
		{:else if tab === 'files'}
			<SandboxFileBrowser {conversationId} />
		{:else if tab === 'preview'}
			<SandboxPreview {conversationId} />
		{/if}
	</div>
</div>

<style>
	.side-panel {
		width: 420px;
		min-width: 280px;
		max-width: 50vw;
	}

	.side-panel-header {
		min-height: 40px;
		background: var(--bs-body-bg);
	}

	.tab-btn {
		color: var(--muted);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		transition: color 100ms ease, border-color 100ms ease;
		white-space: nowrap;
	}

	.tab-btn:hover {
		color: var(--fg);
	}

	.tab-btn.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}

	.close-btn {
		color: var(--muted);
		padding: 0.25rem 0.5rem;
		margin-right: 0.25rem;
	}

	.close-btn:hover {
		color: var(--fg);
	}

	.side-panel-body {
		min-height: 0;
	}

	/* Mobile overlay */
	@media (max-width: 768px) {
		.side-panel {
			position: fixed;
			right: 0;
			top: 0;
			bottom: 0;
			width: min(85vw, 420px);
			max-width: none;
			z-index: 60;
			box-shadow: var(--shadow-md);
		}
	}
</style>
