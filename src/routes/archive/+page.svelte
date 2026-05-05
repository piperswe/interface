<script lang="ts">
	import type { PageData } from './$types';
	import { destroy, unarchive } from '$lib/conversations.remote';
	import { fmtRelative } from '$lib/formatters';
	import { pushToast } from '$lib/toasts';

	let { data }: { data: PageData } = $props();
	const now = Date.now();

	let pending = $state(new Set<string>());
	$effect(() => {
		const visible = new Set(data.archived.map((c) => c.id));
		const stale = [...pending].filter((id) => !visible.has(id));
		if (stale.length > 0) {
			const next = new Set(pending);
			for (const id of stale) next.delete(id);
			pending = next;
		}
	});
	const visibleArchived = $derived(data.archived.filter((c) => !pending.has(c.id)));

	function markPending(id: string) {
		pending = new Set([...pending, id]);
	}
	function unmarkPending(id: string) {
		const next = new Set(pending);
		next.delete(id);
		pending = next;
	}
</script>

<svelte:head>
	<title>Archived conversations</title>
</svelte:head>

<div class="archive-layout d-flex flex-column gap-3 mx-auto w-100 p-3 overflow-auto">
	<h1 class="archive-title fs-3 fw-medium m-0">Archived conversations</h1>
	{#if visibleArchived.length === 0}
		<div class="empty">No archived conversations.</div>
	{:else}
		<ul class="archive-list list-unstyled d-flex flex-column gap-2 m-0 p-0">
			{#each visibleArchived as c (c.id)}
				<li class="archive-item d-flex align-items-center justify-content-between gap-3 flex-wrap border rounded p-2 bg-body">
					<a href={`/c/${c.id}`} class="archive-item-link text-decoration-none text-body d-flex flex-column min-vw-0 flex-fill">
						<span class="archive-item-title fw-medium text-truncate">{c.title}</span>
						<span class="archive-item-meta text-muted small">
							archived {fmtRelative(c.archived_at ?? c.updated_at, now)}
						</span>
					</a>
					<div class="archive-item-actions d-flex gap-2 flex-shrink-0">
						<form {...unarchive.for(c.id).enhance(async ({ submit }) => {
							markPending(c.id);
							try {
								await submit();
								pushToast('Conversation unarchived', 'success');
							} catch (err) {
								unmarkPending(c.id);
								pushToast(err instanceof Error ? err.message : String(err), 'error');
							}
						})}>
							<input type="hidden" name="conversationId" value={c.id} />
							<button type="submit" class="btn btn-sm btn-outline-secondary">Unarchive</button>
						</form>
						<form {...destroy.for(c.id).enhance(async ({ submit }) => {
							if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
							markPending(c.id);
							try {
								await submit();
								pushToast('Conversation deleted', 'success');
							} catch (err) {
								unmarkPending(c.id);
								pushToast(err instanceof Error ? err.message : String(err), 'error');
							}
						})}>
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
