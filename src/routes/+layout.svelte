<script lang="ts">
	import '../app.css';
	import 'katex/dist/katex.min.css';
	import AppShell from '$lib/components/AppShell.svelte';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	const activeConversationId = $derived<string | null>(
		(page.params.id as string | undefined) ?? null,
	);
</script>

<AppShell conversations={data.conversations} {activeConversationId}>
	{@render children()}
</AppShell>
