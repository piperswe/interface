<script lang="ts">
	import { dismissToast, type Toast, toasts } from '$lib/toasts';

	let items = $state<Toast[]>([]);
	toasts.subscribe((v) => (items = v));
</script>

<div class="toaster">
	{#each items as t (t.id)}
		{#if t.type === 'error'}
			<div class="toast-item toast-{t.type}" role="alert" aria-live="assertive" aria-atomic="true">
				<span class="toast-message">{t.message}</span>
				<button type="button" class="toast-dismiss" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>×</button>
			</div>
		{:else}
			<div class="toast-item toast-{t.type}" role="status" aria-live="polite" aria-atomic="true">
				<span class="toast-message">{t.message}</span>
				<button type="button" class="toast-dismiss" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>×</button>
			</div>
		{/if}
	{/each}
</div>

<style>
	.toaster {
		position: fixed;
		bottom: 1rem;
		right: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		z-index: 1080;
		pointer-events: none;
		max-width: min(90vw, 24rem);
	}

	.toast-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.9rem;
		border-radius: 0.4rem;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
		pointer-events: auto;
		font-size: 0.92rem;
		animation: toast-in 160ms ease-out;
	}

	.toast-success {
		background: #2c6e3c;
		color: #fff;
	}

	.toast-error {
		background: #a23a3a;
		color: #fff;
	}

	.toast-message {
		flex: 1;
		min-width: 0;
		word-break: break-word;
	}

	.toast-dismiss {
		background: transparent;
		border: none;
		color: inherit;
		font-size: 1.25rem;
		line-height: 1;
		padding: 0 0.25rem;
		cursor: pointer;
		opacity: 0.85;
	}

	.toast-dismiss:hover {
		opacity: 1;
	}

	@keyframes toast-in {
		from {
			transform: translateY(0.5rem);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}
</style>
