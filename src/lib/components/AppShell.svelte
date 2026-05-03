<script lang="ts" module>
	import type { Conversation } from '$lib/types/conversation';
	import { recencyBand, type RecencyBand } from '$lib/formatters';

	const BAND_ORDER: RecencyBand[] = ['today', 'this-week', 'earlier'];

	export function groupByBand(conversations: Conversation[], now: number): Map<RecencyBand, Conversation[]> {
		const groups = new Map<RecencyBand, Conversation[]>();
		for (const band of BAND_ORDER) groups.set(band, []);
		for (const c of conversations) {
			const band = recencyBand(c.updated_at, now);
			groups.get(band)!.push(c);
		}
		return groups;
	}
</script>

<script lang="ts">
	import { fmtRelative, recencyBandLabel } from '$lib/formatters';
	import type { Snippet } from 'svelte';
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
</script>

<div class="app-shell">
	<input type="checkbox" id="sidebar-toggle" class="sidebar-toggle" />
	<label for="sidebar-toggle" class="sidebar-overlay" aria-hidden="true"></label>
	<aside class="sidebar" aria-label="Conversations">
		<div class="sidebar-header">
			<a href="/" class="sidebar-brand">Interface</a>
			<form {...createNewConversation.enhance(async ({ submit }) => {
				await submit();
			})} class="sidebar-new-chat">
				<button type="submit" aria-label="New chat" title="New chat">New chat</button>
			</form>
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
			<a href="/settings" class="sidebar-footer-link">Settings</a>
		</div>
	</aside>
	<main class="app-main">
		<div class="app-main-header">
			<label for="sidebar-toggle" class="sidebar-toggle-button" aria-label="Toggle sidebar">☰</label>
		</div>
		<div class="app-main-content">{@render children()}</div>
	</main>
</div>
