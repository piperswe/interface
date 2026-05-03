<script lang="ts">
	import { createNewConversation } from '$lib/conversations.remote';
</script>

<svelte:head>
	<title>Interface</title>
</svelte:head>

<div class="empty-state">
	<h1>Start a new chat</h1>
	<p>Pick a conversation from the sidebar, or start fresh.</p>
	<form {...createNewConversation.enhance(async ({ submit }) => { await submit(); })}>
		<button type="submit" class="primary">New chat</button>
	</form>
</div>
