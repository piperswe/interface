<script lang="ts" module>
	import type { Conversation } from '$lib/types/conversation';
	import { BAND_ORDER, groupByBand } from './sidebar';
	export { groupByBand, BAND_ORDER };
</script>

<script lang="ts">
	import { fmtRelative, recencyBandLabel } from '$lib/formatters';
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { createNewConversation } from '$lib/conversations.remote';

	let {
		conversations,
		activeConversationId = null,
		children,
	}: {
		conversations: Conversation[];
		activeConversationId?: string | null;
		children: Snippet;
	} = $props();

	const now = Date.now();
	const grouped = $derived(groupByBand(conversations, now));

	let creatingChat = $state(false);

	function closeDrawer() {
		const toggle = document.getElementById('sidebar-toggle') as HTMLInputElement | null;
		if (toggle) toggle.checked = false;
	}

	async function startNewChat() {
		if (creatingChat) return;
		creatingChat = true;
		try {
			closeDrawer();
			const { id } = await createNewConversation();
			await goto(`/c/${id}`);
		} finally {
			creatingChat = false;
		}
	}
</script>

<div class="app-shell">
	<input type="checkbox" id="sidebar-toggle" class="sidebar-toggle" />
	<label for="sidebar-toggle" class="sidebar-overlay" aria-hidden="true"></label>
	<aside class="sidebar d-flex flex-column h-100 p-2 gap-2 bg-body-tertiary border-end" aria-label="Conversations">
		<div class="sidebar-header d-flex align-items-center justify-content-between gap-2">
			<a href="/" class="sidebar-brand text-decoration-none text-body fw-semibold" onclick={closeDrawer}>Interface</a>
			<div class="sidebar-new-chat">
				<button type="button" class="btn btn-sm btn-outline-secondary" aria-label="New chat" title="New chat" onclick={startNewChat} disabled={creatingChat}>New chat</button>
			</div>
		</div>
		<div class="sidebar-search">
			<input type="search" class="form-control form-control-sm" placeholder="Search conversations…" disabled aria-label="Search" />
		</div>
		<nav class="sidebar-nav flex-fill overflow-auto">
			{#if conversations.length === 0}
				<div class="sidebar-empty p-2 text-muted small">No conversations yet.</div>
			{:else}
				{#each BAND_ORDER as band (band)}
					{@const items = grouped.get(band) ?? []}
					{#if items.length > 0}
						<section class="sidebar-group">
							<div class="sidebar-group-label">{recencyBandLabel(band)}</div>
							<ul class="sidebar-list list-unstyled d-flex flex-column gap-0">
								{#each items as c (c.id)}
									{@const active = c.id === activeConversationId}
									<li>
										<a
											href={`/c/${c.id}`}
											class="sidebar-item d-flex flex-column text-decoration-none text-body small rounded p-2{active ? ' active' : ''}"
											aria-current={active ? 'page' : undefined}
											onclick={closeDrawer}
										>
											<span class="sidebar-item-title fw-medium text-truncate">{c.title}</span>
											<span class="sidebar-item-meta">{fmtRelative(c.updated_at, now)}</span>
										</a>
									</li>
								{/each}
							</ul>
						</section>
					{/if}
				{/each}
			{/if}
		</nav>
		<div class="sidebar-footer d-flex gap-2 pt-2 border-top">
			<a href="/archive" class="sidebar-footer-link text-decoration-none text-muted small rounded p-2" onclick={closeDrawer}>Archive</a>
			<a href="/settings" class="sidebar-footer-link text-decoration-none text-muted small rounded p-2" onclick={closeDrawer}>Settings</a>
		</div>
	</aside>
	<main class="app-main position-relative d-flex flex-column h-100 overflow-hidden min-vw-0">
		<div class="app-main-header">
			<label for="sidebar-toggle" class="sidebar-toggle-button" aria-label="Toggle sidebar">☰</label>
		</div>
		<div class="app-main-content d-flex flex-column flex-fill min-h-0">
			{@render children()}
		</div>
	</main>
</div>

<style>
	.app-shell {
		display: grid;
		grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
		height: 100%;
		overflow: hidden;
	}

	.sidebar-toggle {
		position: absolute;
		left: -10000px;
		width: 1px;
		height: 1px;
		opacity: 0;
	}

	.sidebar-overlay {
		display: none;
	}

	.sidebar {
		width: var(--sidebar-width);
		min-height: 100vh;
		min-height: 100dvh;
	}

	.sidebar-group {
		margin-top: 0.75rem;
	}

	.sidebar-group:first-child {
		margin-top: 0.25rem;
	}

	.sidebar-group-label {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--muted-2);
		padding: 0.25rem 0.5rem;
		margin-bottom: 0.15rem;
	}

	.sidebar-item {
		transition: background 100ms ease;
	}

	.sidebar-item:hover {
		background: var(--bs-tertiary-bg);
	}

	.sidebar-item.active {
		background: var(--user-bg);
	}

	.sidebar-item-meta {
		color: var(--muted-2);
		font-size: 0.7rem;
	}

	.sidebar-footer-link:hover {
		color: var(--fg);
		background: var(--bs-tertiary-bg);
	}

	.app-main-header {
		display: none;
		position: absolute;
		top: 0;
		left: 0;
		z-index: 30;
		padding: calc((var(--mobile-header-min, 56px) - 40px) / 2) 0.5rem;
		pointer-events: none;
	}

	.sidebar-toggle-button {
		display: none;
		pointer-events: auto;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: var(--bs-border-radius);
		color: var(--fg);
		cursor: pointer;
		user-select: none;
		font-size: 1.1rem;
	}

	.sidebar-toggle-button:hover {
		background: var(--bs-secondary-bg);
	}

	/* Mobile drawer */
	@media (max-width: 768px) {
		.app-shell {
			grid-template-columns: minmax(0, 1fr);
		}
		.sidebar {
			position: fixed;
			inset: 0 auto 0 0;
			width: min(80vw, 320px);
			transform: translateX(-100%);
			transition: transform 200ms ease;
			z-index: 50;
			box-shadow: var(--shadow-md);
		}
		.sidebar-toggle:checked ~ .sidebar {
			transform: translateX(0);
		}
		.sidebar-overlay {
			display: block;
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.4);
			opacity: 0;
			pointer-events: none;
			transition: opacity 200ms ease;
			z-index: 40;
		}
		.sidebar-toggle:checked ~ .sidebar-overlay {
			opacity: 1;
			pointer-events: auto;
		}
		.app-main-header {
			display: flex;
		}
		.sidebar-toggle-button {
			display: inline-flex;
		}
	}
</style>
