<script lang="ts" module>
	import type { Conversation } from '$lib/types/conversation';
	import { BAND_ORDER, groupByBand } from './sidebar';
	export { groupByBand, BAND_ORDER };
</script>

<script lang="ts">
	import { fmtRelative, recencyBandLabel } from '$lib/formatters';
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { createNewConversation, archive } from '$lib/conversations.remote';
	import { justSubmit } from '$lib/form-actions';

	let {
		conversations,
		activeConversationId = null,
		children,
	}: {
		conversations: Conversation[];
		activeConversationId?: string | null;
		children: Snippet;
	} = $props();

	// Reactive `now` so relative timestamps in the sidebar refresh while the
	// page sits idle. 60s cadence matches `fmtRelative`'s minute resolution.
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => {
			now = Date.now();
		}, 60_000);
		return () => clearInterval(id);
	});
	const grouped = $derived(groupByBand(conversations, now));

	let creatingChat = $state(false);
	let appShellEl: HTMLDivElement | null = $state(null);
	let isResizing = $state(false);

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
			await goto(`/c/${id}`, { invalidateAll: true });
		} finally {
			creatingChat = false;
		}
	}

	function setSidebarWidth(width: number) {
		if (!appShellEl) return;
		appShellEl.style.setProperty('--sidebar-width', `${width}px`);
	}

	function beginResize(initialWidth: number, startX: number) {
		isResizing = true;
		const minWidth = 200;
		const maxWidth = 400;

		function onMove(e: MouseEvent) {
			const delta = e.clientX - startX;
			const newWidth = Math.min(maxWidth, Math.max(minWidth, initialWidth + delta));
			setSidebarWidth(newWidth);
		}

		function onUp(e: MouseEvent) {
			isResizing = false;
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			const delta = e.clientX - startX;
			const finalWidth = Math.min(maxWidth, Math.max(minWidth, initialWidth + delta));
			try {
				window.localStorage.setItem('sidebarWidth', String(finalWidth));
			} catch {
				// ignore
			}
		}

		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	function onResizerDown(e: MouseEvent) {
		if (!appShellEl) return;
		const style = getComputedStyle(appShellEl);
		const currentWidth = parseFloat(style.getPropertyValue('--sidebar-width'));
		beginResize(currentWidth, e.clientX);
	}

	function restoreWidth() {
		try {
			const saved = window.localStorage.getItem('sidebarWidth');
			if (saved) setSidebarWidth(parseInt(saved, 10));
		} catch {
			// ignore
		}
	}
	onMount(() => {
		restoreWidth();
	});
</script>

<div class="app-shell" bind:this={appShellEl}>
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
									<li class="sidebar-list-item position-relative">
										<a
											href={`/c/${c.id}`}
											class="sidebar-item d-flex flex-column text-decoration-none text-body small rounded p-2{active ? ' active' : ''}"
											aria-current={active ? 'page' : undefined}
											onclick={closeDrawer}
										>
											<span class="sidebar-item-title fw-medium text-truncate">{c.title}</span>
											<span class="sidebar-item-meta">{fmtRelative(c.updated_at, now)}</span>
										</a>
										<form
											class="sidebar-archive-form"
											{...archive.for(c.id).enhance(justSubmit)}
										>
											<input type="hidden" name="conversationId" value={c.id} />
											<input
												type="hidden"
												name="redirectTo"
												value={active ? '/' : page.url.pathname + page.url.search}
											/>
											<button
												type="submit"
												class="sidebar-archive-btn"
												aria-label="Archive conversation"
												title="Archive"
											>
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
													<polyline points="21 8 21 21 3 21 3 8" />
													<rect x="1" y="3" width="22" height="5" />
													<line x1="10" y1="12" x2="14" y2="12" />
												</svg>
											</button>
										</form>
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
		<button
			type="button"
			class="sidebar-resizer"
			aria-label="Resize sidebar"
			onmousedown={onResizerDown}
		></button>
	</aside>
	<main class="app-main position-relative d-flex flex-column h-100 overflow-hidden min-vw-0">
		<div class="app-main-header">
			<label for="sidebar-toggle" class="sidebar-toggle-button" aria-label="Toggle sidebar">☰</label>
		</div>
		<div class="app-main-content d-flex flex-column flex-fill overflow-auto min-h-0">
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
		position: relative;
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
		padding-right: 2rem;
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

	.sidebar-list-item:hover .sidebar-archive-form {
		opacity: 1;
		pointer-events: auto;
	}

	.sidebar-archive-form {
		position: absolute;
		top: 50%;
		right: 0.35rem;
		transform: translateY(-50%);
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms ease;
		margin: 0;
	}

	.sidebar-archive-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--bs-border-radius);
		color: var(--muted-2);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}

	.sidebar-archive-btn:hover {
		background: var(--bs-secondary-bg);
		color: var(--fg);
	}

	.sidebar-resizer {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 4px;
		cursor: col-resize;
		z-index: 10;
		background: transparent;
		border: none;
		padding: 0;
		margin: 0;
		appearance: none;
		outline: none;
		opacity: 0;
	}

	.sidebar-resizer:hover {
		background: var(--accent);
		opacity: 0.15;
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
		.sidebar-resizer {
			display: none;
		}
		.sidebar-archive-form {
			display: none;
		}
	}
</style>
