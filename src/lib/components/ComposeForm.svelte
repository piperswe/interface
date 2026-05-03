<script lang="ts">
	import type { ModelEntry } from '$lib/server/models/config';
	import { sendMessage } from '$lib/conversations.remote';

	let {
		conversationId,
		models,
		defaultModel,
		busy,
	}: {
		conversationId: string;
		models: ModelEntry[];
		defaultModel: string;
		busy: boolean;
	} = $props();

	let formEl: HTMLFormElement | null = $state(null);

	function onKeyDown(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		if (e.shiftKey) return;
		if (busy) return;
		e.preventDefault();
		formEl?.requestSubmit();
	}
</script>

<!--
  Send-message form. Uses the `sendMessage` remote `form` so it works without
  JS (full-page POST + 303 redirect), and progressively enhances when JS is
  available — SvelteKit handles the network call and invalidates the page,
  causing the load function (and SSE re-subscription) to refresh state.
-->
<form
	bind:this={formEl}
	{...sendMessage.for(conversationId).enhance(async ({ form, submit }) => {
		await submit();
		form.reset();
		return;
	})}
	class="compose"
>
	<input type="hidden" name="conversationId" value={conversationId} />
	<textarea
		name="content"
		placeholder="Send a message…"
		required
		disabled={busy}
		rows={1}
		onkeydown={onKeyDown}
	></textarea>
	<div class="row">
		<select name="model" value={defaultModel} aria-label="Model">
			{#each models as m (m.slug)}
				<option value={m.slug}>{m.label}</option>
			{/each}
		</select>
		<button type="submit" class="send" disabled={busy} aria-label={busy ? 'Generating…' : 'Send'}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<line x1="12" y1="19" x2="12" y2="5" />
				<polyline points="5 12 12 5 19 12" />
			</svg>
		</button>
	</div>
</form>
