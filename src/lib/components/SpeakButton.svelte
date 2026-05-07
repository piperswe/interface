<script lang="ts">
	import { onDestroy } from 'svelte';

	let { conversationId, messageId }: { conversationId: string; messageId: string } = $props();

	type State = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
	let phase = $state<State>('idle');
	let errorMessage = $state<string | null>(null);

	let audio: HTMLAudioElement | null = null;
	let blobUrl: string | null = null;

	function cleanup() {
		if (audio) {
			audio.pause();
			audio.src = '';
			audio = null;
		}
		if (blobUrl) {
			URL.revokeObjectURL(blobUrl);
			blobUrl = null;
		}
	}

	onDestroy(cleanup);

	async function ensureAudio(): Promise<HTMLAudioElement> {
		if (audio && blobUrl) return audio;
		const res = await fetch(`/c/${conversationId}/m/${messageId}/speak`);
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(detail || `TTS request failed (${res.status})`);
		}
		const blob = await res.blob();
		blobUrl = URL.createObjectURL(blob);
		const a = new Audio(blobUrl);
		a.addEventListener('ended', () => { phase = 'idle'; });
		a.addEventListener('pause', () => {
			// Only flip to paused if we didn't naturally end (which fires pause too).
			if (!a.ended && phase === 'playing') phase = 'paused';
		});
		a.addEventListener('play', () => { phase = 'playing'; });
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
			const a = await ensureAudio();
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
	const glyph = $derived(
		phase === 'playing' ? '⏸' : phase === 'loading' ? '⏳' : phase === 'error' ? '⚠' : '▶',
	);
</script>

<button
	type="button"
	class="speak-button btn btn-sm"
	onclick={onClick}
	aria-label={label}
	title={errorMessage ?? label}
	disabled={phase === 'loading'}
>
	<span aria-hidden="true">{glyph}</span>
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
	.speak-button[disabled] {
		opacity: 0.5;
		cursor: progress;
	}
</style>
