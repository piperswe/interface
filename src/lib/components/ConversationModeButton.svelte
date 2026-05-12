<script lang="ts">
	import type {
		ConversationMode,
		ConversationModeSnapshot,
	} from '$lib/conversation-mode.client';
	import {
		Headphones,
		Circle,
		PenLine,
		Send,
		MessageCircle,
		Volume2,
		CircleStop,
		Headset,
	} from 'lucide-svelte';

	let { mode, disabled = false }: { mode: ConversationMode; disabled?: boolean } = $props();

	let snapshot = $state<ConversationModeSnapshot | null>(null);
	$effect(() => mode.subscribe((s) => {
		snapshot = s;
	}));

	const phase = $derived(snapshot?.phase ?? 'idle');
	const active = $derived(snapshot?.active === true);

	const phaseText = $derived(
		phase === 'listening'
			? 'Listening…'
			: phase === 'recording'
				? 'Recording'
				: phase === 'transcribing'
					? 'Transcribing'
					: phase === 'sending'
						? 'Sending'
						: phase === 'thinking'
							? 'Thinking'
							: phase === 'speaking'
								? 'Speaking'
								: '',
	);

	const toggleLabel = $derived(active ? 'Stop conversation mode' : 'Start conversation mode');

	async function onToggle() {
		await mode.toggle();
	}

	function onStopTurn() {
		mode.stopTurn();
	}
</script>

<button
	type="button"
	class="cm-button"
	class:active
	onclick={onToggle}
	{disabled}
	aria-pressed={active}
	aria-label={toggleLabel}
	title={toggleLabel}
>
	{#if active}
		<CircleStop size={18} aria-hidden="true" />
	{:else}
		<Headset size={18} aria-hidden="true" />
	{/if}
</button>

{#if active}
	<div class="cm-status" role="status" aria-live="polite">
		<span class="cm-pill">
			{#if phase === 'listening'}
				<Headphones size={14} aria-hidden="true" />
			{:else if phase === 'recording'}
				<Circle size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" />
			{:else if phase === 'transcribing'}
				<PenLine size={14} aria-hidden="true" />
			{:else if phase === 'sending'}
				<Send size={14} aria-hidden="true" />
			{:else if phase === 'thinking'}
				<MessageCircle size={14} aria-hidden="true" />
			{:else if phase === 'speaking'}
				<Volume2 size={14} aria-hidden="true" />
			{/if}
			<span>{phaseText}</span>
		</span>
		{#if phase === 'recording'}
			<button type="button" class="cm-stop-turn" onclick={onStopTurn} title="End your turn now">
				End turn
			</button>
		{/if}
	</div>
{/if}

<style>
	.cm-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		font-size: 0.95rem;
		line-height: 1;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}

	.cm-button:hover:not([disabled]) {
		background: var(--bs-secondary-bg);
		color: var(--fg);
	}

	.cm-button[disabled] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.cm-button.active {
		color: var(--accent);
		background: var(--bs-secondary-bg);
		animation: cm-pulse 1.6s ease-in-out infinite;
	}

	@keyframes cm-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(13, 110, 253, 0.35); }
		50% { box-shadow: 0 0 0 6px rgba(13, 110, 253, 0); }
	}

	.cm-status {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		margin-left: 0.25rem;
	}

	.cm-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.2rem 0.6rem;
		font-size: 0.8125rem;
		background: var(--bs-secondary-bg);
		border: 1px solid var(--border-soft);
		border-radius: 999px;
		color: var(--fg);
		white-space: nowrap;
	}

	.cm-stop-turn {
		padding: 0.2rem 0.55rem;
		font-size: 0.75rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}

	.cm-stop-turn:hover {
		background: var(--bs-secondary-bg);
		color: var(--fg);
	}
</style>
