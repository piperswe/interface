<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { ConversationState } from '$lib/types/conversation';
	import Message from '$lib/components/Message.svelte';
	import ComposeForm from '$lib/components/ComposeForm.svelte';
	import { fmtCost } from '$lib/formatters';
	import { attachConversationStream } from '$lib/conversation-stream';
	import { createStreamingMarkdownRunner } from '$lib/streaming-markdown';
	import { archive, destroy, regenerateTitle } from '$lib/conversations.remote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const initialState = $derived(data.initialState);
	let convState: ConversationState = $state(untrack(() => data.initialState));
	let currentConversationId = $state(untrack(() => data.conversation.id));
	let scrollEl: HTMLDivElement | null = $state(null);
	let stickToBottom = $state(true);

	$effect(() => {
		const id = data.conversation.id;
		if (id !== currentConversationId) {
			currentConversationId = id;
			convState = untrack(() => data.initialState);
		}
	});

	$effect(() => {
		const server = initialState;
		if (convState.inProgress !== null) return;
		const localLast = convState.messages.at(-1);
		const serverLast = server.messages.at(-1);
		if (!localLast && !serverLast) return;
		const serverHasNew = !localLast || (serverLast && serverLast.id !== localLast.id);
		const statusChanged = localLast && serverLast && localLast.id === serverLast.id && localLast.status !== serverLast.status;
		if (serverHasNew || statusChanged) {
			convState = server;
		}
	});

	const busy = $derived(convState.inProgress !== null);
	const lastModel = $derived(
		[...convState.messages].reverse().find((m) => m.role === 'assistant' && m.model)?.model ??
			data.models[0]?.slug ??
			'',
	);
	const totalCost = $derived(
		convState.messages.reduce((sum: number, m) => {
			if (m.role !== 'assistant' || !m.meta) return sum;
			const cost = m.meta.generation?.totalCost ?? m.meta.usage?.cost;
			return typeof cost === 'number' ? sum + cost : sum;
		}, 0),
	);

	const mdRunner = createStreamingMarkdownRunner(
		() => convState,
		(next) => {
			convState = next;
		},
	);
	onMount(() => {
		const detach = attachConversationStream(
			data.conversation.id,
			() => convState,
			(next) => {
				convState = next;
			},
			() => invalidateAll(),
		);
		return () => {
			detach();
			mdRunner.dispose();
		};
	});

	$effect(() => {
		void convState.messages;
		mdRunner.pulse();
	});

	$effect(() => {
		const el = scrollEl;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		stickToBottom = true;
		const onScroll = () => {
			const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
			stickToBottom = distance <= 80;
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});
	$effect(() => {
		void convState.messages;
		const el = scrollEl;
		if (!el || !stickToBottom) return;
		const handle = requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
		});
		return () => cancelAnimationFrame(handle);
	});

	async function onRegenerate() {
		await regenerateTitle(data.conversation.id);
		await invalidateAll();
	}
</script>

<svelte:head>
	<title>{data.conversation.title}</title>
</svelte:head>

<div class="conversation-layout d-flex flex-column flex-fill min-h-0">
	<div class="conversation-header d-flex align-items-center justify-content-between gap-3 flex-wrap border-bottom px-side py-2">
		<h1 class="conversation-title fs-6 fw-medium m-0 flex-fill text-truncate">{data.conversation.title}</h1>
		<button
			type="button"
			title="Regenerate title"
			disabled={busy}
			class="title-action-button btn btn-sm"
			onclick={onRegenerate}
			aria-label="Regenerate title"
		>↻</button>
		{#if totalCost > 0}<span class="conversation-cost small text-muted font-monospace">Cost: {fmtCost(totalCost)}</span>{/if}
		<details class="conversation-menu">
			<summary class="title-action-button btn btn-sm" aria-label="Conversation actions" title="More actions">⋯</summary>
			<div class="conversation-menu-panel" role="menu">
				<form
					{...archive.for(data.conversation.id).enhance(async ({ submit }) => {
						await submit();
					})}
				>
					<input type="hidden" name="conversationId" value={data.conversation.id} />
					<button type="submit" class="conversation-menu-item" role="menuitem">Archive</button>
				</form>
				<form
					{...destroy.for(data.conversation.id).enhance(async ({ submit }) => {
						if (!confirm(`Delete "${data.conversation.title}"? This cannot be undone.`)) return;
						await submit();
					})}
				>
					<input type="hidden" name="conversationId" value={data.conversation.id} />
					<button type="submit" class="conversation-menu-item danger" role="menuitem">Delete</button>
				</form>
			</div>
		</details>
	</div>
	<div bind:this={scrollEl} class="conversation-scroll flex-fill overflow-auto px-side py-3">
		<div class="conversation-column mx-auto w-100">
			{#if convState.messages.length === 0}
				<div class="empty">No messages yet — send the first one below.</div>
			{:else}
				<div class="messages d-flex flex-column gap-4">
					{#each convState.messages as m (m.id)}
						<Message message={m} />
					{/each}
				</div>
			{/if}
		</div>
	</div>
	<div class="conversation-compose border-top pt-2 pb-2 px-side">
		<div class="conversation-column mx-auto w-100">
			<ComposeForm
				conversationId={data.conversation.id}
				models={data.models}
				defaultModel={lastModel}
				thinkingBudget={data.thinkingBudget}
				{busy}
			/>
		</div>
	</div>
</div>

<style>
	.conversation-layout {
		max-width: none;
	}

	.conversation-header {
		min-height: var(--tap-target);
	}

	.conversation-title {
		min-width: 0;
	}

	.title-action-button {
		min-height: 28px;
		min-width: 28px;
		padding: 0.15rem 0.35rem;
		font-size: 0.9rem;
		line-height: 1;
		background: transparent;
		border: 1px solid transparent;
		color: var(--muted-2);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}

	.title-action-button:hover:not([disabled]) {
		background: var(--bs-secondary-bg);
		color: var(--fg);
	}

	.title-action-button[disabled] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.conversation-menu {
		position: relative;
		margin-left: auto;
	}

	.conversation-menu > summary {
		list-style: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.conversation-menu > summary::-webkit-details-marker {
		display: none;
	}

	.conversation-menu-panel {
		position: absolute;
		top: calc(100% + 0.25rem);
		right: 0;
		min-width: 180px;
		padding: 0.25rem;
		background: var(--bs-body-bg);
		border: 1px solid var(--bs-border-color);
		border-radius: var(--bs-border-radius-lg);
		box-shadow: var(--shadow-md);
		z-index: 20;
		display: flex;
		flex-direction: column;
	}

	.conversation-menu-panel form {
		margin: 0;
	}

	.conversation-menu-item {
		width: 100%;
		min-height: 36px;
		padding: 0.4rem 0.6rem;
		font-size: 0.875rem;
		text-align: left;
		background: transparent;
		border: none;
		border-radius: var(--bs-border-radius);
		color: var(--fg);
		cursor: pointer;
	}

	.conversation-menu-item:hover {
		background: var(--bs-secondary-bg);
	}

	.conversation-menu-item.danger {
		color: var(--error-fg);
	}

	.conversation-menu-item.danger:hover {
		background: var(--error-bg);
	}

	.conversation-cost {
		font-variant-numeric: tabular-nums;
	}

	.conversation-scroll {
		max-height: 100%;
		scroll-behavior: auto;
	}

	.conversation-column {
		max-width: var(--chat-max-width);
	}

	.conversation-compose {
		background: linear-gradient(to top, var(--bg) 70%, transparent);
		padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0));
	}

	/* Mobile header overrides */
	@media (max-width: 768px) {
		.conversation-header {
			padding-left: calc(40px + 1rem);
		}
	}
</style>
