<script lang="ts">
	import type { PageData } from './$types';
	import { destroy, unarchive } from '$lib/conversations.remote';
	import { fmtRelative } from '$lib/formatters';

	let { data }: { data: PageData } = $props();
	const now = Date.now();
</script>

<svelte:head>
	<title>Archived conversations</title>
</svelte:head>

<div class="archive-layout">
	<h1 class="archive-title">Archived conversations</h1>
	{#if data.archived.length === 0}
		<div class="empty">No archived conversations.</div>
	{:else}
		<ul class="archive-list">
			{#each data.archived as c (c.id)}
				<li class="archive-item">
					<a href={`/c/${c.id}`} class="archive-item-link">
						<span class="archive-item-title">{c.title}</span>
						<span class="archive-item-meta">
							archived {fmtRelative(c.archived_at ?? c.updated_at, now)}
						</span>
					</a>
					<div class="archive-item-actions">
						<form
							{...unarchive.for(c.id).enhance(async ({ submit }) => {
								await submit();
							})}
						>
							<input type="hidden" name="conversationId" value={c.id} />
							<button type="submit">Unarchive</button>
						</form>
						<form
							{...destroy.for(c.id).enhance(async ({ submit }) => {
								if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
								await submit();
							})}
						>
							<input type="hidden" name="conversationId" value={c.id} />
							<button type="submit" class="danger">Delete</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
