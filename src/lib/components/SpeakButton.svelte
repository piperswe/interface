<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Play, Pause, Loader, TriangleAlert } from 'lucide-svelte';

	let { conversationId, messageId }: { conversationId: string; messageId: string } = $props();

	type Phase = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
	let phase = $state<Phase>('idle');
	let errorMessage = $state<string | null>(null);

	let audio: HTMLAudioElement | null = null;

	function cleanup() {
		if (audio) {
			audio.pause();
			audio.src = '';
			audio = null;
		}
	}
	onDestroy(cleanup);

	function ensureAudio(): HTMLAudioElement {
		if (audio) return audio;
		const a = new Audio(`/c/${conversationId}/m/${messageId}/speak`);
		// Browser progressively downloads MP3 and starts playback as soon as
		// enough frames have arrived — the first chunk's bytes are enough to
		// begin, so we hear audio while later chunks are still synthesising.
		a.preload = 'none';
		a.addEventListener('playing', () => { phase = 'playing'; });
		a.addEventListener('pause', () => {
			if (!a.ended && phase !== 'idle' && phase !== 'error') phase = 'paused';
		});
		a.addEventListener('waiting', () => { phase = 'loading'; });
		a.addEventListener('ended', () => {
			a.currentTime = 0;
			phase = 'idle';
		});
		a.addEventListener('error', () => {
			phase = 'error';
			errorMessage = a.error?.message || 'Playback failed';
		});
		audio = a;
		return a;
	}

	async function onClick() {
		errorMessage = null;
		try {
			if (phase === 'playing' && audio) {
				audio.pause();
				return;
			}
			if (phase === 'paused' && audio) {
				await audio.play();
				return;
			}
			phase = 'loading';
			const a = ensureAudio();
			await a.play();
		} catch (err) {
			phase = 'error';
			errorMessage = err instanceof Error ? err.message : String(err);
		}
	}

	const label = $derived(
		phase === 'playing'
			? 'Pause'
			: phase === 'loading'
				? 'Loading…'
				: phase === 'paused'
					? 'Resume'
					: phase === 'error'
						? 'Retry'
						: 'Read aloud',
	);
</script>

<button
	type="button"
	class="speak-button btn btn-sm"
	onclick={onClick}
	aria-label={label}
	title={errorMessage ?? label}
>
	{#if phase === 'playing'}
		<Pause size={14} aria-hidden="true" />
	{:else if phase === 'loading'}
		<Loader class="spin" size={14} aria-hidden="true" />
	{:else if phase === 'error'}
		<TriangleAlert size={14} aria-hidden="true" />
	{:else}
		<Play size={14} aria-hidden="true" />
	{/if}
</button>

<style>
	.speak-button {
		min-height: 28px;
		min-width: 28px;
		padding: 0.15rem 0.4rem;
		font-size: 0.85rem;
		line-height: 1;
		background: transparent;
		border: 1px solid transparent;
		color: var(--muted-2);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}
	.speak-button:hover:not([disabled]) {
		background: var(--bs-secondary-bg);
		color: var(--accent);
	}
	.speak-button :global(.spin) {
		animation: speak-spin 1s linear infinite;
	}
	@keyframes speak-spin {
		to { transform: rotate(360deg); }
	}
</style>
