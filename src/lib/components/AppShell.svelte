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

	// Collapse the mobile drawer once the user picks a conversation (or hits
	// Settings) so the conversation is visible immediately. Desktop hides
	// the toggle in CSS, so this is a no-op there.
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
	<aside class="sidebar" aria-label="Conversations">
		<div class="sidebar-header">
			<a href="/" class="sidebar-brand" onclick={closeDrawer}>Interface</a>
			<div class="sidebar-new-chat">
				<button type="button" aria-label="New chat" title="New chat" onclick={startNewChat} disabled={creatingChat}>New chat</button>
			</div>
		</div>
		<div class="sidebar-search">
			<input type="search" placeholder="Search conversations…" disabled aria-label="Search" />
		</div>
		<nav class="sidebar-nav">
			{#if conversations.length === 0}
				<div class="sidebar-empty">No conversations yet.</div>
			{:else}
				{#each BAND_ORDER as band (band)}
					{@const items = grouped.get(band) ?? []}
					{#if items.length > 0}
						<section class="sidebar-group">
							<div class="sidebar-group-label">{recencyBandLabel(band)}</div>
							<ul class="sidebar-list">
								{#each items as c (c.id)}
									{@const active = c.id === activeConversationId}
									<li>
										<a
											href={`/c/${c.id}`}
											class="sidebar-item{active ? ' active' : ''}"
											aria-current={active ? 'page' : undefined}
											onclick={closeDrawer}
										>
											<span class="sidebar-item-title">{c.title}</span>
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
		<div class="sidebar-footer">
			<a href="/archive" class="sidebar-footer-link" onclick={closeDrawer}>Archive</a>
			<a href="/settings" class="sidebar-footer-link" onclick={closeDrawer}>Settings</a>
		</div>
	</aside>
	<main class="app-main">
		<div class="app-main-header">
			<label for="sidebar-toggle" class="sidebar-toggle-button" aria-label="Toggle sidebar">☰</label>
		</div>
		<div class="app-main-content">{@render children()}</div>
	</main>
</div>
