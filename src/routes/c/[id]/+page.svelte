<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { ConversationState } from '$lib/types/conversation';
	import Message from '$lib/components/Message.svelte';
	import ComposeForm from '$lib/components/ComposeForm.svelte';
	import SidePanel from '$lib/components/SidePanel.svelte';
	import { fmtCost } from '$lib/formatters';
	import { attachConversationStream } from '$lib/conversation-stream';
	import { createStreamingMarkdownRunner } from '$lib/streaming-markdown';
	import { archive, destroy, regenerateTitle, setConversationStyle, setConversationSystemPrompt } from '$lib/conversations.remote';
	import { confirmToastSubmit, toastSubmit } from '$lib/form-actions';
	import { clickOutside } from '$lib/click-outside';
	import { pushToast } from '$lib/toasts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const initialState = $derived(data.initialState);
	let convState: ConversationState = $state(untrack(() => data.initialState));
	let currentConversationId = $state(untrack(() => data.conversation.id));
	let scrollEl: HTMLDivElement | null = $state(null);
	let menuEl: HTMLDetailsElement | null = $state(null);
	let stickToBottom = $state(true);
	let promptDraft = $state(untrack(() => data.systemPromptOverride));
	let promptOpen = $state(false);
	let sidePanelOpen = $state(false);
	let sidePanelTab = $state<'artifacts' | 'files' | 'preview'>('artifacts');
	let selectedArtifactId = $state<string | null>(null);

	const allArtifacts = $derived(
		convState.messages.flatMap((m) => m.artifacts ?? []),
	);

	function openSidePanel(tab: 'artifacts' | 'files' | 'preview' = 'artifacts') {
		sidePanelTab = tab;
		sidePanelOpen = true;
	}

	function closeSidePanel() {
		sidePanelOpen = false;
	}

	function selectArtifact(id: string) {
		selectedArtifactId = id;
		openSidePanel('artifacts');
	}

	$effect(() => {
		// Re-sync the draft when the conversation switches.
		void data.conversation.id;
		promptDraft = untrack(() => data.systemPromptOverride);
	});

	function closeMenu() {
		if (menuEl?.open) menuEl.open = false;
	}

	let optimisticStyleId = $state<number | null | undefined>(undefined);
	const styleSelectValue = $derived(
		(optimisticStyleId === undefined ? data.styleId : optimisticStyleId) == null
			? ''
			: String(optimisticStyleId === undefined ? data.styleId : optimisticStyleId),
	);

	async function onStyleChange(e: Event) {
		const target = e.target as HTMLSelectElement;
		const v = target.value;
		const styleId = v ? Number.parseInt(v, 10) : null;
		optimisticStyleId = styleId;
		try {
			await setConversationStyle({ conversationId: data.conversation.id, styleId });
			pushToast(styleId ? 'Style applied' : 'Style cleared');
		} catch (err) {
			optimisticStyleId = undefined;
			pushToast(err instanceof Error ? err.message : 'Failed to update style', 'error');
		}
	}

	$effect(() => {
		void data.styleId;
		optimisticStyleId = undefined;
	});

	async function onSavePrompt() {
		const trimmed = promptDraft.trim();
		try {
			await setConversationSystemPrompt({
				conversationId: data.conversation.id,
				prompt: trimmed ? trimmed : null,
			});
			pushToast(trimmed ? 'Conversation prompt saved' : 'Conversation prompt cleared');
		} catch (err) {
			pushToast(err instanceof Error ? err.message : 'Failed to save prompt', 'error');
		}
	}

	$effect(() => {
		const id = data.conversation.id;
		if (id !== currentConversationId) {
			currentConversationId = id;
			convState = untrack(() => data.initialState);
		}
	});

	$effect(() => {
		const server = initialState;
		// Skip syncing when both sides agree a real stream is in flight against
		// the same message — the SSE deltas are authoritative for content. If
		// our local inProgress is an optimistic placeholder (different id), or
		// the server has already finished, we must reconcile.
		if (
			convState.inProgress !== null &&
			server.inProgress !== null &&
			convState.inProgress.messageId === server.inProgress.messageId
		) {
			return;
		}
		const localLast = convState.messages.at(-1);
		const serverLast = server.messages.at(-1);
		if (!localLast && !serverLast) return;
		const serverHasNew = !localLast || (serverLast && serverLast.id !== localLast.id);
		const statusChanged = localLast && serverLast && localLast.id === serverLast.id && localLast.status !== serverLast.status;
		if (serverHasNew || statusChanged) {
			convState = server;
		}
	});

	function pushOptimisticUserMessage(content: string, model: string) {
		const now = Date.now();
		const userId = `optimistic-user-${now}`;
		const asstId = `optimistic-asst-${now}`;
		convState = {
			messages: [
				...convState.messages,
				{
					id: userId,
					role: 'user',
					content,
					model: null,
					status: 'complete',
					error: null,
					createdAt: now,
					meta: null,
				},
				{
					id: asstId,
					role: 'assistant',
					content: '',
					model,
					status: 'streaming',
					error: null,
					createdAt: now + 1,
					meta: null,
					parts: [],
				},
			],
			inProgress: { messageId: asstId, content: '' },
		};
	}

	function revertOptimisticUserMessage() {
		convState = {
			messages: convState.messages.filter((m) => !m.id.startsWith('optimistic-')),
			inProgress: convState.inProgress && convState.inProgress.messageId.startsWith('optimistic-')
				? null
				: convState.inProgress,
		};
	}

	const busy = $derived(convState.inProgress !== null);
	const lastModel = $derived(
		[...convState.messages].reverse().find((m) => m.role === 'assistant' && m.model)?.model ??
			(data.defaultModel || (data.models[0] ? `${data.models[0].providerId}/${data.models[0].id}` : '')),
	);
	const contextUsed = $derived(
		[...convState.messages].reverse().find((m) => m.role === 'assistant' && m.meta?.usage?.inputTokens)?.meta?.usage?.inputTokens ?? 0,
	);
	// Cost tracking removed with OpenRouter-specific generation stats.
	// Token counts are available via m.meta.usage if needed.
	const totalCost = $derived(0);

	const mdRunner = createStreamingMarkdownRunner(
		() => convState,
		(next) => {
			convState = next;
		},
	);

	// The page component is reused when navigating between conversations,
	// so onMount only fires once. Attach the SSE stream reactively so
	// every conversation change gets its own subscription.
	$effect(() => {
		const id = data.conversation.id;
		const detach = attachConversationStream(
			id,
			() => convState,
			(next) => {
				convState = next;
			},
			() => invalidateAll(),
		);
		return () => {
			detach();
		};
	});

	onMount(() => {
		return () => {
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
	// Track the size of the last message so the auto-scroll only fires when
	// content actually grows, not on every reactive re-evaluation of `messages`.
	const scrollSignature = $derived(
		(() => {
			const last = convState.messages.at(-1);
			if (!last) return `${convState.messages.length}:0:0`;
			const lastPart = last.parts?.at(-1);
			const partLen =
				lastPart && (lastPart.type === 'text' || lastPart.type === 'thinking') ? lastPart.text.length : 0;
			return `${convState.messages.length}:${last.content.length}:${partLen}:${last.status}`;
		})(),
	);
	$effect(() => {
		void scrollSignature;
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
		<button
			type="button"
			title="Toggle side panel"
			class="title-action-button btn btn-sm"
			onclick={() => sidePanelOpen ? closeSidePanel() : openSidePanel()}
			aria-label="Toggle side panel"
			aria-expanded={sidePanelOpen}
		>☰</button>
		{#if data.styles.length > 0}
			<select
				class="form-select form-select-sm w-auto"
				value={styleSelectValue}
				onchange={onStyleChange}
				title="Style"
				aria-label="Style"
			>
				<option value="">No style</option>
				{#each data.styles as s (s.id)}
					<option value={String(s.id)}>{s.name}</option>
				{/each}
			</select>
		{/if}
		{#if totalCost > 0}<span class="conversation-cost small text-muted font-monospace">Cost: {fmtCost(totalCost)}</span>{/if}
		<details bind:this={menuEl} class="conversation-menu" use:clickOutside={closeMenu}>
			<summary class="title-action-button btn btn-sm" aria-label="Conversation actions" title="More actions">⋯</summary>
			<div class="conversation-menu-panel" role="menu">
				<button
					type="button"
					class="conversation-menu-item"
					role="menuitem"
					onclick={() => { promptOpen = !promptOpen; closeMenu(); }}
				>
					{data.systemPromptOverride ? 'Edit system prompt' : 'Override system prompt'}
				</button>
				<a
					class="conversation-menu-item"
					role="menuitem"
					href={`/c/${data.conversation.id}/export?format=md`}
					onclick={() => closeMenu()}
				>
					Export as Markdown
				</a>
				<a
					class="conversation-menu-item"
					role="menuitem"
					href={`/c/${data.conversation.id}/export?format=json`}
					onclick={() => closeMenu()}
				>
					Export as JSON
				</a>
				<form {...archive.for(data.conversation.id).enhance(toastSubmit('Conversation archived'))}>
					<input type="hidden" name="conversationId" value={data.conversation.id} />
					<button type="submit" class="conversation-menu-item" role="menuitem">Archive</button>
				</form>
				<form
					{...destroy
						.for(data.conversation.id)
						.enhance(confirmToastSubmit(`Delete "${data.conversation.title}"? This cannot be undone.`, 'Conversation deleted'))}
				>
					<input type="hidden" name="conversationId" value={data.conversation.id} />
					<button type="submit" class="conversation-menu-item danger" role="menuitem">Delete</button>
				</form>
			</div>
		</details>
	</div>
	{#if promptOpen}
		<div class="conversation-prompt-panel border-bottom px-side py-2">
			<label for="conv-system-prompt" class="form-label small text-muted mb-1">
				System prompt for this conversation
				<span class="text-muted">— overrides the global setting; leave empty to fall back.</span>
			</label>
			<textarea
				id="conv-system-prompt"
				class="form-control form-control-sm"
				rows="4"
				bind:value={promptDraft}
				placeholder="(Falls back to the global system prompt)"
			></textarea>
			<div class="d-flex gap-2 mt-2">
				<button type="button" class="btn btn-sm btn-primary" onclick={onSavePrompt}>Save</button>
				<button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => { promptOpen = false; promptDraft = data.systemPromptOverride; }}>Close</button>
			</div>
		</div>
	{/if}
	<div class="conversation-main d-flex flex-row flex-fill overflow-hidden">
		<div class="chat-area d-flex flex-column flex-fill min-w-0 overflow-hidden">
			<div bind:this={scrollEl} class="conversation-scroll flex-fill overflow-auto px-side py-3">
				<div class="conversation-column mx-auto w-100">
					{#if convState.messages.length === 0}
						<div class="empty">No messages yet — send the first one below.</div>
					{:else}
						<div class="messages d-flex flex-column gap-4">
							{#each convState.messages as m, i (m.id)}
								{#if m.role !== 'system'}
									{@const prev = convState.messages[i - 1]}
									{@const timestamp = m.role === 'user' && prev?.role === 'system' ? prev.createdAt : undefined}
									<Message message={m} {timestamp} onSelectArtifact={selectArtifact} />
								{/if}
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
						{contextUsed}
						onOptimisticSubmit={pushOptimisticUserMessage}
						onOptimisticRevert={revertOptimisticUserMessage}
					/>
				</div>
			</div>
		</div>
		{#if sidePanelOpen}
			<SidePanel
				conversationId={data.conversation.id}
				artifacts={allArtifacts}
				tab={sidePanelTab}
				selectedArtifactId={selectedArtifactId}
				onClose={closeSidePanel}
				onTabChange={(t) => sidePanelTab = t}
				onSelectArtifact={selectArtifact}
			/>
		{/if}
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

	.conversation-main {
		min-height: 0;
	}

	.chat-area {
		min-width: 0;
	}

	/* Mobile header overrides */
	@media (max-width: 768px) {
		.conversation-header {
			padding-left: calc(40px + 1rem);
		}
	}
</style>
