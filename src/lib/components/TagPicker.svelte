<script lang="ts">
	import { Check } from 'lucide-svelte';
	import { invalidateAll } from '$app/navigation';
	import { clickOutside } from '$lib/click-outside';
	import type { Tag } from '$lib/server/tags';
	import { createAndTagConversation, tagConversation } from '$lib/tags.remote';
	import { pushToast } from '$lib/toasts';

	let {
		conversationId,
		availableTags,
		conversationTagIds,
	}: {
		conversationId: string;
		availableTags: Tag[];
		conversationTagIds: number[];
	} = $props();

	let detailsEl: HTMLDetailsElement | null = $state(null);
	let newName = $state('');
	let busy = $state(false);
	const attached = $derived(new Set(conversationTagIds));
	const activeChips = $derived(availableTags.filter((t) => attached.has(t.id)));

	function close() {
		if (detailsEl?.open) detailsEl.open = false;
	}

	async function toggle(tag: Tag, e?: Event) {
		e?.preventDefault();
		if (busy) return;
		busy = true;
		try {
			await tagConversation({
				attached: !attached.has(tag.id),
				conversationId,
				tagId: tag.id,
			});
			await invalidateAll();
		} catch (err) {
			pushToast(err instanceof Error ? err.message : String(err), 'error');
		} finally {
			busy = false;
		}
	}

	async function createTag(e: SubmitEvent) {
		e.preventDefault();
		const name = newName.trim();
		if (!name || busy) return;
		busy = true;
		try {
			await createAndTagConversation({ conversationId, name });
			newName = '';
			await invalidateAll();
		} catch (err) {
			pushToast(err instanceof Error ? err.message : String(err), 'error');
		} finally {
			busy = false;
		}
	}
</script>

<details bind:this={detailsEl} class="tag-picker" use:clickOutside={close}>
	<summary class="title-action-button btn btn-sm" aria-label="Conversation tags" title="Tags">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
			<line x1="7" y1="7" x2="7.01" y2="7" />
		</svg>
		{#if activeChips.length > 0}
			<span class="tag-picker-count">{activeChips.length}</span>
		{/if}
	</summary>
	<div class="tag-picker-panel" role="menu">
		<div class="tag-picker-header">Tag this conversation</div>
		{#if availableTags.length === 0}
			<div class="tag-picker-empty">No tags yet. Create one below.</div>
		{:else}
			<ul class="tag-picker-list list-unstyled">
				{#each availableTags as t (t.id)}
					{@const checked = attached.has(t.id)}
					<li>
						<button
							type="button"
							class="tag-picker-item"
							class:checked
							onclick={(e) => toggle(t, e)}
							disabled={busy}
						>
							<span class="tag-picker-check" aria-hidden="true">
								{#if checked}<Check size={12} aria-hidden="true" />{/if}
							</span>
							<span class="tag-picker-name" data-color={t.color ?? 'gray'}>{t.name}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<form class="tag-picker-create" onsubmit={createTag}>
			<input
				type="text"
				class="form-control form-control-sm"
				placeholder="New tag name…"
				bind:value={newName}
				maxlength="64"
				aria-label="New tag name"
			/>
			<button type="submit" class="btn btn-sm btn-outline-secondary" disabled={busy || !newName.trim()}>Add</button>
		</form>
	</div>
</details>

<style>
	.tag-picker {
		position: relative;
	}

	.tag-picker-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.1rem;
		height: 1.1rem;
		font-size: 0.65rem;
		padding: 0 0.3rem;
		margin-left: 0.25rem;
		border-radius: 999px;
		background: var(--bs-tertiary-bg);
	}

	.tag-picker-panel {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		min-width: 240px;
		background: var(--bs-body-bg);
		border: 1px solid var(--bs-border-color);
		border-radius: var(--bs-border-radius);
		box-shadow: var(--shadow-md);
		padding: 0.5rem;
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.tag-picker-header {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted-2);
	}

	.tag-picker-empty {
		font-size: 0.85rem;
		color: var(--muted-2);
	}

	.tag-picker-list {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		max-height: 240px;
		overflow-y: auto;
	}

	.tag-picker-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.3rem 0.4rem;
		border: none;
		background: transparent;
		color: var(--fg);
		text-align: left;
		cursor: pointer;
		border-radius: var(--bs-border-radius-sm);
	}

	.tag-picker-item:hover {
		background: var(--bs-tertiary-bg);
	}

	.tag-picker-check {
		display: inline-flex;
		justify-content: center;
		width: 1rem;
		color: var(--accent, var(--bs-primary, #0d6efd));
	}

	.tag-picker-name {
		display: inline-block;
		font-size: 0.8rem;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		background: var(--bs-tertiary-bg);
		border: 1px solid var(--bs-border-color);
	}

	.tag-picker-name[data-color='red'] { background: rgba(220, 53, 69, 0.15); }
	.tag-picker-name[data-color='orange'] { background: rgba(253, 126, 20, 0.15); }
	.tag-picker-name[data-color='amber'] { background: rgba(255, 193, 7, 0.18); }
	.tag-picker-name[data-color='green'] { background: rgba(25, 135, 84, 0.15); }
	.tag-picker-name[data-color='teal'] { background: rgba(32, 201, 151, 0.15); }
	.tag-picker-name[data-color='blue'] { background: rgba(13, 110, 253, 0.15); }
	.tag-picker-name[data-color='indigo'] { background: rgba(102, 16, 242, 0.15); }
	.tag-picker-name[data-color='purple'] { background: rgba(111, 66, 193, 0.15); }
	.tag-picker-name[data-color='pink'] { background: rgba(214, 51, 132, 0.15); }

	.tag-picker-create {
		display: flex;
		gap: 0.25rem;
		border-top: 1px solid var(--bs-border-color);
		padding-top: 0.5rem;
	}
</style>
