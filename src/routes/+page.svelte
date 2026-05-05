<script lang="ts">
	import { goto } from '$app/navigation';
	import { createNewConversation } from '$lib/conversations.remote';

	async function startNewChat() {
		const id = crypto.randomUUID();
		createNewConversation({ id }).catch((err) => {
			console.error('Failed to create conversation', err);
		});
		await goto(`/c/${id}`, { invalidateAll: true });
	}
</script>

<svelte:head>
	<title>Interface</title>
</svelte:head>

<div class="empty-state d-flex flex-column align-items-center justify-content-center text-center gap-3 h-100 p-3">
	<h1 class="fs-3 fw-medium m-0">Start a new chat</h1>
	<p class="text-muted m-0">Pick a conversation from the sidebar, or start fresh.</p>
	<button type="button" class="btn btn-primary" onclick={startNewChat}>New chat</button>
</div>

<style>
	.empty-state {
		flex: 1;
	}
</style>
