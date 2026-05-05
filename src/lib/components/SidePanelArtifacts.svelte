<script lang="ts">
	import { onMount } from 'svelte';
	import type { Artifact } from '$lib/types/conversation';
	import ArtifactViewer from './ArtifactViewer.svelte';

	let {
		artifacts = [],
		selectedId = null,
		onSelect,
	}: {
		artifacts: Artifact[];
		selectedId: string | null;
		onSelect: (id: string) => void;
	} = $props();

	const selectedArtifact = $derived(artifacts.find((a) => a.id === selectedId));

	function handleKeydown(e: KeyboardEvent, id: string) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onSelect(id);
		}
	}
</script>

<div class="artifacts-tab d-flex flex-column h-100">
	<div class="artifacts-list flex-shrink-0 border-bottom">
		{#if artifacts.length === 0}
			<div class="empty p-2 small text-muted">No artifacts in this conversation.</div>
		{:else}
			<div class="d-flex flex-column">
				{#each artifacts as a (a.id)}
					<button
						type="button"
						class="artifact-list-item d-flex align-items-center gap-2 px-2 py-1 text-start border-0"
						class:active={a.id === selectedId}
						onclick={() => onSelect(a.id)}
						onkeydown={(e) => handleKeydown(e, a.id)}
						role="tab"
						aria-selected={a.id === selectedId}
						tabindex="0"
					>
						<span class="artifact-list-type text-uppercase small">{a.type}</span>
						<span class="artifact-list-name text-truncate small">{a.name ?? 'Untitled'}</span>
						{#if a.version > 1}<span class="artifact-list-version small text-muted">v{a.version}</span>{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
	<div class="artifact-viewer flex-fill overflow-auto">
		{#if selectedArtifact}
			<ArtifactViewer artifact={selectedArtifact} />
		{:else}
			<div class="empty p-3 small text-muted text-center">Select an artifact to view it.</div>
		{/if}
	</div>
</div>

<style>
	.artifacts-list {
		max-height: 45%;
		overflow-y: auto;
	}

	.artifact-list-item {
		background: transparent;
		cursor: pointer;
		transition: background 100ms ease;
		min-height: 32px;
	}

	.artifact-list-item:hover,
	.artifact-list-item.active {
		background: var(--bs-secondary-bg);
	}

	.artifact-list-item:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.artifact-list-type {
		font-weight: 600;
		color: var(--accent);
		flex-shrink: 0;
		min-width: 3.5rem;
	}

	.artifact-list-name {
		color: var(--fg);
		flex: 1;
		min-width: 0;
	}

	.artifact-list-version {
		flex-shrink: 0;
	}

	.artifact-viewer {
		min-height: 0;
	}

	.empty {
		font-style: italic;
	}
</style>
