<script lang="ts">
	import '../app.scss';
	import 'katex/dist/katex.min.css';
	import AppShell from '$lib/components/AppShell.svelte';
	import Toaster from '$lib/components/Toaster.svelte';
	import { navigating, page } from '$app/state';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	const activeConversationId = $derived<string | null>(
		(page.params.id as string | undefined) ?? null,
	);

	const navigatingToConversation = $derived(navigating.to?.route?.id === '/c/[id]');
	let showSpinner = $state(false);

	$effect(() => {
		if (!navigatingToConversation) return;
		const handle = setTimeout(() => {
			showSpinner = true;
		}, 130);
		return () => {
			clearTimeout(handle);
			showSpinner = false;
		};
	});
</script>

<AppShell
	conversations={data.conversations}
	{activeConversationId}
	tags={data.tags}
	conversationTags={data.conversationTags}
>
	{@render children()}
</AppShell>
<Toaster />
{#if showSpinner}
	<div
		class="nav-spinner-overlay"
		role="status"
		aria-live="polite"
		aria-label="Loading conversation"
	>
		<span class="spinner"></span>
	</div>
{/if}

<style>
	.nav-spinner-overlay {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--bg) 70%, transparent);
		backdrop-filter: blur(2px);
		z-index: 50;
		pointer-events: none;
	}

	.spinner {
		display: inline-block;
		width: 1.75rem;
		height: 1.75rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
