<script lang="ts">
	import type { ModelEntry } from '$lib/server/models/config';
	import { sendMessage, setThinkingBudget } from '$lib/conversations.remote';
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';

	let {
		conversationId,
		models,
		defaultModel,
		thinkingBudget,
		busy,
	}: {
		conversationId: string;
		models: ModelEntry[];
		defaultModel: string;
		thinkingBudget: number | null;
		busy: boolean;
	} = $props();

	let formEl: HTMLFormElement | null = $state(null);
	let optionsEl: HTMLDetailsElement | null = $state(null);
	let selectedModel = $state(untrack(() => defaultModel));
	let budgetInput = $state(untrack(() => thinkingBudget ?? 0));
	const currentLabel = $derived(models.find((m) => m.slug === selectedModel)?.label ?? selectedModel);
	const budgetSummary = $derived(thinkingBudget && thinkingBudget > 0 ? `${thinkingBudget} tok` : 'off');

	function onKeyDown(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		if (e.shiftKey) return;
		if (busy) return;
		e.preventDefault();
		formEl?.requestSubmit();
	}

	function pickModel(slug: string) {
		selectedModel = slug;
		if (optionsEl) optionsEl.open = false;
	}

	async function saveBudget() {
		const parsed = Number.parseInt(String(budgetInput), 10);
		const budget = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
		await setThinkingBudget({ conversationId, budget });
		await invalidateAll();
		if (optionsEl) optionsEl.open = false;
	}

	// Close the popover when the user clicks outside of it.
	function onDocPointerDown(e: PointerEvent) {
		if (!optionsEl?.open) return;
		if (e.target instanceof Node && optionsEl.contains(e.target)) return;
		optionsEl.open = false;
	}
	$effect(() => {
		document.addEventListener('pointerdown', onDocPointerDown);
		return () => document.removeEventListener('pointerdown', onDocPointerDown);
	});
</script>

<!--
  Send-message form. Uses the `sendMessage` remote `form` so it works without
  JS (full-page POST + 303 redirect), and progressively enhances when JS is
  available — SvelteKit handles the network call and invalidates the page,
  causing the load function (and SSE re-subscription) to refresh state.

  Model + thinking-budget live in a popover anchored to the bottom-left of
  the compose area (claude.ai-style). Without JS, native `<details>` still
  toggles the panel and a regular submit on the message form picks up the
  selected model from the radio group.
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
		<details bind:this={optionsEl} class="compose-options">
			<summary class="compose-options-button" aria-label="Model and options">
				<span class="compose-options-model">{currentLabel}</span>
				<span class="compose-options-sep" aria-hidden="true">·</span>
				<span class="compose-options-meta">Thinking: {budgetSummary}</span>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
					class="compose-options-chevron"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</summary>
			<div class="compose-options-panel" role="menu">
				<div class="compose-options-section">
					<div class="compose-options-section-label">Model</div>
					<ul class="compose-options-models">
						{#each models as m (m.slug)}
							<li>
								<label class="compose-options-model-option">
									<input
										type="radio"
										name="model"
										value={m.slug}
										checked={m.slug === selectedModel}
										onchange={() => pickModel(m.slug)}
									/>
									<span>{m.label}</span>
								</label>
							</li>
						{/each}
					</ul>
				</div>
				<div class="compose-options-section">
					<div class="compose-options-section-label">Thinking budget</div>
					<div class="compose-options-budget">
						<input
							type="number"
							min="0"
							step="1024"
							placeholder="0 = off"
							bind:value={budgetInput}
							aria-label="Thinking token budget"
						/>
						<button type="button" onclick={saveBudget}>Save</button>
					</div>
				</div>
			</div>
		</details>
		<button type="submit" class="send" disabled={busy} aria-label={busy ? 'Generating…' : 'Send'}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<line x1="12" y1="19" x2="12" y2="5" />
				<polyline points="5 12 12 5 19 12" />
			</svg>
		</button>
	</div>
</form>
