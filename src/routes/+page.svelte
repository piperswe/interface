<script lang="ts">
	import { goto } from '$app/navigation';
	import { createNewConversation } from '$lib/conversations.remote';

	let busy = $state(false);

	async function startNewChat() {
		if (busy) return;
		busy = true;
		try {
			const { id } = await createNewConversation();
			await goto(`/c/${id}`);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Interface</title>
</svelte:head>

<div class="empty-state">
	<h1>Start a new chat</h1>
	<p>Pick a conversation from the sidebar, or start fresh.</p>
	<button type="button" class="primary" onclick={startNewChat} disabled={busy}>New chat</button>
</div>
