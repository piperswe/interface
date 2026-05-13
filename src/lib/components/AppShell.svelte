<script lang="ts" module>
	import type { Tag } from '$lib/server/tags';
	import type { Conversation } from '$lib/types/conversation';
	import { BAND_ORDER, groupByBand, mergeOptimisticConversations } from './sidebar';

	export { BAND_ORDER, groupByBand, mergeOptimisticConversations };
</script>

<script lang="ts">
	import { Archive, Menu, Search } from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { z } from 'zod';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { archive, createNewConversation } from '$lib/conversations.remote';
	import { fmtRelative, recencyBandLabel } from '$lib/formatters';
	import { pushToast } from '$lib/toasts';
	import SearchPalette from './SearchPalette.svelte';

	let {
		conversations,
		activeConversationId = null,
		tags = [],
		conversationTags = {},
		children,
	}: {
		conversations: Conversation[];
		activeConversationId?: string | null;
		tags?: Tag[];
		conversationTags?: Record<string, number[]>;
		children: Snippet;
	} = $props();

	let activeTagFilter = $state<number | null>(null);
	const filteredConversations = $derived.by(() => {
		const filter = activeTagFilter;
		if (filter == null) return conversations;
		return conversations.filter((c) => (conversationTags[c.id] ?? []).includes(filter));
	});
	const tagById = $derived(new Map(tags.map((t) => [t.id, t])));

	// Reactive `now` so relative timestamps in the sidebar refresh while the
	// page sits idle. 60s cadence matches `fmtRelative`'s minute resolution.
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => {
			now = Date.now();
		}, 60_000);
		return () => clearInterval(id);
	});
	let optimisticallyArchived = $state(new Set<string>());
	let optimisticallyCreated = $state<Conversation[]>([]);
	$effect(() => {
		// Drop ids from the optimistic set once the server-side list reflects the
		// archive (the conversation no longer appears in `conversations`). Avoids
		// the set growing unbounded across many archive operations.
		const visible = new Set(conversations.map((c) => c.id));
		const stale = [...optimisticallyArchived].filter((id) => !visible.has(id));
		if (stale.length > 0) {
			const next = new Set(optimisticallyArchived);
			for (const id of stale) next.delete(id);
			optimisticallyArchived = next;
		}
		// Drop optimistic conversations once the real row appears in `data`.
		const realIds = new Set(conversations.map((c) => c.id));
		const stillPending = optimisticallyCreated.filter((c) => !realIds.has(c.id));
		if (stillPending.length !== optimisticallyCreated.length) {
			optimisticallyCreated = stillPending;
		}
	});
	const visibleConversations = $derived(
		mergeOptimisticConversations(
			optimisticallyCreated,
			filteredConversations,
			optimisticallyArchived,
		),
	);
	const grouped = $derived(groupByBand(visibleConversations, now));

	let appShellEl: HTMLDivElement | null = $state(null);
	let isResizing = $state(false);
	let searchOpen = $state(false);
	const isMacLike = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

	function closeDrawer() {
		const toggle = document.getElementById('sidebar-toggle') as HTMLInputElement | null;
		if (toggle) toggle.checked = false;
	}

	async function startNewChat() {
		closeDrawer();
		const id = crypto.randomUUID();
		const ts = Date.now();
		optimisticallyCreated = [
			{ created_at: ts, id, title: 'New conversation', updated_at: ts },
			...optimisticallyCreated,
		];
		// Fire-and-forget: the server creates the row asynchronously. The page
		// loader at /c/[id] also materialises the row if it lands first, so the
		// user can begin typing immediately.
		createNewConversation({ id }).catch((err) => {
			optimisticallyCreated = optimisticallyCreated.filter((c) => c.id !== id);
			console.error('Failed to create conversation', err);
		});
		await goto(`/c/${id}`, { invalidateAll: true });
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
			if (saved == null) return;
			const parsed = z.coerce.number().int().finite().safeParse(saved);
			if (parsed.success) setSidebarWidth(parsed.data);
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
				<button type="button" class="btn btn-sm btn-outline-secondary" aria-label="New chat" title="New chat" onclick={startNewChat}>New chat</button>
			</div>
		</div>
		<div class="sidebar-search">
			<button
				type="button"
				class="sidebar-search-trigger form-control form-control-sm d-flex align-items-center gap-2"
				onclick={() => (searchOpen = true)}
				aria-label="Open search"
				title={isMacLike ? '⌘K to search' : 'Ctrl+K to search'}
			>
				<Search size={14} aria-hidden="true" />
				<span class="flex-fill text-start text-muted">Search…</span>
				<kbd class="sidebar-search-kbd">{isMacLike ? '⌘K' : 'Ctrl+K'}</kbd>
			</button>
		</div>
		{#if tags.length > 0}
			<div class="sidebar-tags d-flex flex-wrap gap-1">
				<button
					type="button"
					class="sidebar-tag-chip"
					class:active={activeTagFilter == null}
					onclick={() => (activeTagFilter = null)}
				>All</button>
				{#each tags as t (t.id)}
					<button
						type="button"
						class="sidebar-tag-chip"
						class:active={activeTagFilter === t.id}
						data-color={t.color ?? 'gray'}
						onclick={() => (activeTagFilter = activeTagFilter === t.id ? null : t.id)}
					>{t.name}</button>
				{/each}
			</div>
		{/if}
		<nav class="sidebar-nav flex-fill overflow-auto">
			{#if conversations.length === 0}
				<div class="sidebar-empty p-2 text-muted small">No conversations yet.</div>
			{:else if filteredConversations.length === 0}
				<div class="sidebar-empty p-2 text-muted small">No conversations match this tag.</div>
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
											<span class="sidebar-item-meta d-flex align-items-center gap-1 flex-wrap">
												<span>{fmtRelative(c.updated_at, now)}</span>
												{#each (conversationTags[c.id] ?? []) as tagId (tagId)}
													{@const t = tagById.get(tagId)}
													{#if t}
														<span class="sidebar-item-tag" data-color={t.color ?? 'gray'}>{t.name}</span>
													{/if}
												{/each}
											</span>
										</a>
												<form
													class="sidebar-archive-form"
													{...archive.for(`sidebar-${c.id}`).enhance(async ({ submit }) => {
														optimisticallyArchived = new Set([...optimisticallyArchived, c.id]);
														try {
															await submit();
														} catch (err) {
															const next = new Set(optimisticallyArchived);
															next.delete(c.id);
															optimisticallyArchived = next;
															pushToast(err instanceof Error ? err.message : 'Failed to archive', 'error');
														}
													})}
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
												<Archive size={14} aria-hidden="true" />
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
	<SearchPalette bind:open={searchOpen} />
	<main class="app-main position-relative d-flex flex-column h-100 overflow-hidden min-vw-0">
		<div class="app-main-header">
			<label for="sidebar-toggle" class="sidebar-toggle-button" aria-label="Toggle sidebar"><Menu size={18} aria-hidden="true" /></label>
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
		/* biome-ignore lint/suspicious/noDuplicateProperties: progressive enhancement — `100vh` fallback for browsers without `dvh` support (Android WebViews / pre-2022 builds). */
		min-height: 100dvh;
	}

	.sidebar-tags {
		padding: 0 0.25rem;
	}

	.sidebar-tag-chip {
		font-size: 0.7rem;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--bs-border-color);
		background: var(--bs-body-bg);
		color: var(--fg);
		cursor: pointer;
		line-height: 1.4;
	}

	.sidebar-tag-chip.active {
		background: var(--user-bg, var(--bs-tertiary-bg));
		border-color: var(--accent, var(--bs-primary, #0d6efd));
	}

	.sidebar-item-tag {
		display: inline-block;
		font-size: 0.65rem;
		line-height: 1.2;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: var(--bs-tertiary-bg);
		color: var(--fg);
		border: 1px solid var(--bs-border-color);
	}

	.sidebar-tag-chip[data-color='red'], .sidebar-item-tag[data-color='red'] { background: rgba(220, 53, 69, 0.15); border-color: rgba(220, 53, 69, 0.4); }
	.sidebar-tag-chip[data-color='orange'], .sidebar-item-tag[data-color='orange'] { background: rgba(253, 126, 20, 0.15); border-color: rgba(253, 126, 20, 0.4); }
	.sidebar-tag-chip[data-color='amber'], .sidebar-item-tag[data-color='amber'] { background: rgba(255, 193, 7, 0.18); border-color: rgba(255, 193, 7, 0.45); }
	.sidebar-tag-chip[data-color='green'], .sidebar-item-tag[data-color='green'] { background: rgba(25, 135, 84, 0.15); border-color: rgba(25, 135, 84, 0.4); }
	.sidebar-tag-chip[data-color='teal'], .sidebar-item-tag[data-color='teal'] { background: rgba(32, 201, 151, 0.15); border-color: rgba(32, 201, 151, 0.4); }
	.sidebar-tag-chip[data-color='blue'], .sidebar-item-tag[data-color='blue'] { background: rgba(13, 110, 253, 0.15); border-color: rgba(13, 110, 253, 0.4); }
	.sidebar-tag-chip[data-color='indigo'], .sidebar-item-tag[data-color='indigo'] { background: rgba(102, 16, 242, 0.15); border-color: rgba(102, 16, 242, 0.4); }
	.sidebar-tag-chip[data-color='purple'], .sidebar-item-tag[data-color='purple'] { background: rgba(111, 66, 193, 0.15); border-color: rgba(111, 66, 193, 0.4); }
	.sidebar-tag-chip[data-color='pink'], .sidebar-item-tag[data-color='pink'] { background: rgba(214, 51, 132, 0.15); border-color: rgba(214, 51, 132, 0.4); }

	.sidebar-search-trigger {
		background: var(--bs-body-bg);
		cursor: pointer;
		text-align: left;
		color: var(--muted-2);
	}

	.sidebar-search-trigger:hover {
		background: var(--bs-tertiary-bg);
	}

	.sidebar-search-kbd {
		font-size: 0.65rem;
		padding: 0.05rem 0.3rem;
		border: 1px solid var(--bs-border-color);
		border-radius: 4px;
		color: var(--muted-2);
		background: var(--bs-tertiary-bg);
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

	.sidebar-list-item:hover .sidebar-archive-form {
		opacity: 1;
		pointer-events: auto;
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
