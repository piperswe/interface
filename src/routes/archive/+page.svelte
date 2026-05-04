<script lang="ts">
	import type { PageData } from './$types';
	import { destroy, unarchive } from '$lib/conversations.remote';
	import { confirmToastSubmit, toastSubmit } from '$lib/form-actions';
	import { fmtRelative } from '$lib/formatters';

	let { data }: { data: PageData } = $props();
	const now = Date.now();
</script>

<svelte:head>
	<title>Archived conversations</title>
</svelte:head>

<div class="archive-layout d-flex flex-column gap-3 mx-auto w-100 p-3 overflow-auto">
	<h1 class="archive-title fs-3 fw-medium m-0">Archived conversations</h1>
	{#if data.archived.length === 0}
		<div class="empty">No archived conversations.</div>
	{:else}
		<ul class="archive-list list-unstyled d-flex flex-column gap-2 m-0 p-0">
			{#each data.archived as c (c.id)}
				<li class="archive-item d-flex align-items-center justify-content-between gap-3 flex-wrap border rounded p-2 bg-body">
					<a href={`/c/${c.id}`} class="archive-item-link text-decoration-none text-body d-flex flex-column min-vw-0 flex-fill">
						<span class="archive-item-title fw-medium text-truncate">{c.title}</span>
						<span class="archive-item-meta text-muted small">
							archived {fmtRelative(c.archived_at ?? c.updated_at, now)}
						</span>
					</a>
					<div class="archive-item-actions d-flex gap-2 flex-shrink-0">
						<form {...unarchive.for(c.id).enhance(toastSubmit('Conversation unarchived'))}>
							<input type="hidden" name="conversationId" value={c.id} />
							<button type="submit" class="btn btn-sm btn-outline-secondary">Unarchive</button>
						</form>
						<form {...destroy.for(c.id).enhance(confirmToastSubmit(`Delete "${c.title}"? This cannot be undone.`, 'Conversation deleted'))}>
							<input type="hidden" name="conversationId" value={c.id} />
							<button type="submit" class="btn btn-sm btn-outline-danger">Delete</button>
						</form>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.archive-layout {
		max-width: 760px;
		min-height: 0;
		flex: 1;
	}

	@media (max-width: 768px) {
		.archive-layout {
			padding-top: calc(0.5rem + 40px + 0.5rem);
		}
	}
</style>
