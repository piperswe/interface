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

	// `convState` mirrors `data.initialState` on first render, then diverges
	// as live SSE deltas mutate it directly without going through the load
	// function. The `$effect` below re-syncs after `invalidateAll()` (e.g.
	// from a `refresh` SSE event) ONLY when the server state indicates a
	// structural change — it must NOT clobber an in-progress stream.
	const initialState = $derived(data.initialState);
	let convState: ConversationState = $state(untrack(() => data.initialState));
	let scrollEl: HTMLDivElement | null = $state(null);
	let stickToBottom = $state(true);

	$effect(() => {
		const server = initialState;
		// If a generation is currently streaming, the local state is the
		// source of truth. Overwriting it would drop deltas that arrived
		// between the fetch start and this effect running.
		if (convState.inProgress !== null) return;
		// Only sync when the server has advanced beyond our local copy.
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

	// Pulse the streaming-markdown runner whenever message convState changes.
	$effect(() => {
		void convState.messages;
		mdRunner.pulse();
	});

	// Sticky scroll: pin to the bottom across renders, but step out of the
	// way once the user scrolls up to read history. Mirrors the previous
	// React `useStickyScroll` hook.
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

<div class="conversation-layout">
	<div class="conversation-header">
		<h1 class="conversation-title">{data.conversation.title}</h1>
		<button
			type="button"
			title="Regenerate title"
			disabled={busy}
			class="title-action-button"
			onclick={onRegenerate}
			aria-label="Regenerate title"
		>↻</button>
		{#if totalCost > 0}<span class="conversation-cost">Cost: {fmtCost(totalCost)}</span>{/if}
		<details class="conversation-menu">
			<summary class="title-action-button" aria-label="Conversation actions" title="More actions">⋯</summary>
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
	<div bind:this={scrollEl} class="conversation-scroll">
		<div class="conversation-column">
			{#if convState.messages.length === 0}
				<div class="empty">No messages yet — send the first one below.</div>
			{:else}
				<div class="messages">
					{#each convState.messages as m (m.id)}
						<Message message={m} />
					{/each}
				</div>
			{/if}
		</div>
	</div>
	<div class="conversation-compose">
		<div class="conversation-column">
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
