<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { searchConversations } from '$lib/search.remote';
	import type { SearchHit } from '$lib/server/search';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let input = $state('');
	let results = $state<SearchHit[]>([]);
	let selectedIndex = $state(0);
	let loading = $state(false);
	let inputEl: HTMLInputElement | null = $state(null);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let lastQuery = '';

	$effect(() => {
		// Re-focus + reset when palette opens.
		if (open) {
			input = '';
			results = [];
			selectedIndex = 0;
			tick().then(() => inputEl?.focus());
		}
	});

	$effect(() => {
		const q = input;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (!q.trim()) {
			results = [];
			loading = false;
			return;
		}
		loading = true;
		debounceTimer = setTimeout(async () => {
			lastQuery = q;
			try {
				const hits = await searchConversations(q);
				// Drop late responses if a newer query has already started.
				if (lastQuery !== q) return;
				results = hits;
				selectedIndex = 0;
			} finally {
				if (lastQuery === q) loading = false;
			}
		}, 150);
	});

	function close() {
		open = false;
	}

	function jumpTo(hit: SearchHit) {
		const url = hit.messageId ? `/c/${hit.conversationId}#m-${hit.messageId}` : `/c/${hit.conversationId}`;
		close();
		goto(url, { invalidateAll: false });
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (results.length > 0) selectedIndex = (selectedIndex + 1) % results.length;
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (results.length > 0) selectedIndex = (selectedIndex - 1 + results.length) % results.length;
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			const hit = results[selectedIndex];
			if (hit) jumpTo(hit);
		}
	}

	// Global Cmd-K / Ctrl-K listener.
	onMount(() => {
		function onGlobalKey(e: KeyboardEvent) {
			const isMeta = e.metaKey || e.ctrlKey;
			if (isMeta && (e.key === 'k' || e.key === 'K')) {
				e.preventDefault();
				open = !open;
			}
		}
		window.addEventListener('keydown', onGlobalKey);
		return () => window.removeEventListener('keydown', onGlobalKey);
	});
</script>

{#if open}
	<div
		class="palette-backdrop"
		onclick={close}
		onkeydown={(e) => { if (e.key === 'Escape') close(); }}
		role="dialog"
		aria-modal="true"
		aria-label="Search conversations"
		tabindex="-1"
	>
		<div
			class="palette card shadow-lg"
			onclick={(e) => e.stopPropagation()}
			onkeydown={onKey}
			role="presentation"
		>
			<div class="palette-input-row">
				<svg class="palette-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="11" cy="11" r="8" />
					<line x1="21" y1="21" x2="16.65" y2="16.65" />
				</svg>
				<input
					bind:this={inputEl}
					bind:value={input}
					type="text"
					class="form-control palette-input"
					placeholder="Search conversations and messages…"
					aria-label="Search query"
					autocomplete="off"
					spellcheck="false"
				/>
				<kbd class="palette-kbd">Esc</kbd>
			</div>
			<div class="palette-results">
				{#if loading && results.length === 0}
					<div class="palette-empty">Searching…</div>
				{:else if !input.trim()}
					<div class="palette-empty">Start typing to search across all conversations.</div>
				{:else if results.length === 0}
					<div class="palette-empty">No matches.</div>
				{:else}
					<ul class="palette-list list-unstyled">
						{#each results as hit, i (`${hit.conversationId}-${hit.messageId ?? 'title'}`)}
							<li>
								<button
									type="button"
									class="palette-item"
									class:active={i === selectedIndex}
									onmouseenter={() => (selectedIndex = i)}
									onclick={() => jumpTo(hit)}
								>
									<div class="palette-item-title">
										{hit.conversationTitle}
										<span class="palette-item-role">{hit.role === 'title' ? 'title' : hit.role}</span>
									</div>
									<div class="palette-item-snippet">
										{@html hit.snippet}
									</div>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.palette-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding-top: 10vh;
		z-index: 200;
	}

	.palette {
		width: min(640px, 90vw);
		background: var(--bs-body-bg);
		border: 1px solid var(--bs-border-color);
		display: flex;
		flex-direction: column;
		max-height: 70vh;
		overflow: hidden;
	}

	.palette-input-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--bs-border-color);
	}

	.palette-icon {
		color: var(--muted-2);
		flex: 0 0 auto;
	}

	.palette-input {
		flex: 1 1 auto;
		border: none;
		box-shadow: none;
		background: transparent;
		padding: 0.25rem 0;
		font-size: 1rem;
	}

	.palette-input:focus {
		outline: none;
		box-shadow: none;
	}

	.palette-kbd {
		font-size: 0.7rem;
		padding: 0.1rem 0.35rem;
		border: 1px solid var(--bs-border-color);
		border-radius: 4px;
		color: var(--muted-2);
		background: var(--bs-tertiary-bg);
	}

	.palette-results {
		overflow-y: auto;
		flex: 1 1 auto;
	}

	.palette-empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--muted-2);
		font-size: 0.9rem;
	}

	.palette-list {
		margin: 0;
		padding: 0.25rem 0;
	}

	.palette-item {
		display: block;
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: none;
		background: transparent;
		color: var(--fg);
		text-align: left;
		cursor: pointer;
		border-radius: 0;
	}

	.palette-item.active,
	.palette-item:hover {
		background: var(--bs-tertiary-bg);
	}

	.palette-item-title {
		font-weight: 500;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.palette-item-role {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-2);
		font-weight: 400;
	}

	.palette-item-snippet {
		font-size: 0.8rem;
		color: var(--muted-2);
		margin-top: 0.15rem;
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.palette-item-snippet :global(mark) {
		background: var(--accent, #ffd54f);
		color: inherit;
		padding: 0 0.1rem;
		border-radius: 2px;
	}
</style>
