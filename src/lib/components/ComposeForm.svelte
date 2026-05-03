<script lang="ts" module>
	import { THINKING_PRESETS, describeBudget, presetFor } from './thinking-presets';
	export { THINKING_PRESETS, describeBudget, presetFor };
	export type { Preset } from './thinking-presets';
</script>

<script lang="ts">
	import type { ModelEntry } from '$lib/server/models/config';
	import { sendMessage, setThinkingBudget } from '$lib/conversations.remote';
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import type { Preset } from './thinking-presets';

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

	let activePresetId = $state(untrack(() => presetFor(thinkingBudget)?.id ?? 'custom'));
	let customInput = $state(
		untrack(() => (presetFor(thinkingBudget) == null && thinkingBudget != null ? thinkingBudget : 0)),
	);
	$effect(() => {
		const matched = presetFor(thinkingBudget);
		activePresetId = matched?.id ?? 'custom';
		if (matched == null && thinkingBudget != null) customInput = thinkingBudget;
	});

	const currentLabel = $derived(models.find((m) => m.slug === selectedModel)?.label ?? selectedModel);
	const budgetSummary = $derived(describeBudget(thinkingBudget));
	const selectedReasoning = $derived(models.find((m) => m.slug === selectedModel)?.reasoning);

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

	async function applyBudget(budget: number | null) {
		await setThinkingBudget({ conversationId, budget });
		await invalidateAll();
	}

	async function pickPreset(p: Preset) {
		activePresetId = p.id;
		await applyBudget(p.budget);
	}

	async function applyCustom() {
		const parsed = Number.parseInt(String(customInput), 10);
		const budget = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
		activePresetId = 'custom';
		await applyBudget(budget);
	}

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

<form
	bind:this={formEl}
	{...sendMessage.for(conversationId).enhance(async ({ form, submit }) => {
		await submit();
		const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="content"]');
		if (textarea) textarea.value = '';
	})}
	class="compose d-flex flex-column gap-2 bg-body border rounded-4 p-2 ps-3"
>
	<input type="hidden" name="conversationId" value={conversationId} />
	<textarea
		name="content"
		placeholder="Send a message…"
		required
		disabled={busy}
		rows={1}
		onkeydown={onKeyDown}
		class="form-control border-0 shadow-none bg-transparent p-1"
	></textarea>
	<div class="d-flex align-items-center gap-2 flex-wrap">
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
					<ul class="list-unstyled d-flex flex-column gap-0 m-0 p-0">
						{#each models as m (m.slug)}
							<li>
								<label class="compose-options-model-option d-flex align-items-center gap-2 rounded p-2">
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
					<ul class="list-unstyled d-flex flex-column gap-0 m-0 p-0">
						{#each THINKING_PRESETS as p (p.id)}
						<li>
							<label class="compose-options-preset d-flex align-items-center gap-2 rounded p-2">
								<input
									type="radio"
									name="thinking_preset"
									value={p.id}
									checked={activePresetId === p.id}
									onchange={() => pickPreset(p)}
								/>
								<span class="compose-options-preset-label">{p.label}</span>
								{#if p.budget != null && selectedReasoning !== 'effort'}
									<span class="compose-options-preset-meta">{p.budget.toLocaleString()} tok</span>
								{/if}
							</label>
						</li>
						{/each}
						<li>
							<label class="compose-options-preset d-flex align-items-center gap-2 rounded p-2">
								<input
									type="radio"
									name="thinking_preset"
									value="custom"
									checked={activePresetId === 'custom'}
									onchange={() => (activePresetId = 'custom')}
								/>
								<span class="compose-options-preset-label">Custom</span>
							</label>
							{#if activePresetId === 'custom'}
								<div class="compose-options-budget">
									<input
										type="number"
										min="0"
										step="1024"
										placeholder="0 = off"
										bind:value={customInput}
										aria-label="Custom thinking token budget"
										class="form-control form-control-sm"
									/>
									<button type="button" class="btn btn-sm btn-primary" onclick={applyCustom}>Save</button>
								</div>
							{/if}
						</li>
					</ul>
				</div>
			</div>
		</details>
		<button type="submit" class="send btn btn-primary rounded-circle d-flex align-items-center justify-content-center flex-shrink-0" disabled={busy} aria-label={busy ? 'Generating…' : 'Send'}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width: 18px; height: 18px">
				<line x1="12" y1="19" x2="12" y2="5" />
				<polyline points="5 12 12 5 19 12" />
			</svg>
		</button>
	</div>
</form>

<style>
	.compose {
		box-shadow: var(--shadow-sm);
		transition: border-color 120ms ease, box-shadow 120ms ease;
	}

	.compose:focus-within {
		border-color: var(--muted-2);
		box-shadow: var(--shadow-md);
	}

	.compose textarea {
		width: 100%;
		min-height: 2.5rem;
		max-height: 50vh;
		resize: none;
		font-family: inherit;
		font-size: 1rem;
		line-height: 1.5;
	}

	.compose textarea::placeholder {
		color: var(--muted-2);
	}

	.compose-options {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
	}

	.compose-options-button {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.65rem;
		min-height: 32px;
		font-size: 0.8125rem;
		color: var(--muted);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 999px;
		cursor: pointer;
		user-select: none;
		max-width: 100%;
		list-style: none;
		-webkit-tap-highlight-color: transparent;
	}

	.compose-options-button::-webkit-details-marker {
		display: none;
	}

	.compose-options-button:hover {
		background: var(--bs-secondary-bg);
		color: var(--fg);
	}

	.compose-options[open] > .compose-options-button {
		background: var(--bs-secondary-bg);
		color: var(--fg);
		border-color: var(--border-soft);
	}

	.compose-options-model {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.compose-options-sep,
	.compose-options-meta {
		color: var(--muted-2);
		white-space: nowrap;
	}

	.compose-options-chevron {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		transition: transform 120ms ease;
	}

	.compose-options[open] .compose-options-chevron {
		transform: rotate(180deg);
	}

	.compose-options-panel {
		position: absolute;
		bottom: calc(100% + 0.5rem);
		left: 0;
		min-width: 240px;
		max-width: min(320px, calc(100vw - 2 * var(--side-gap)));
		padding: 0.5rem;
		background: var(--bs-body-bg);
		border: 1px solid var(--border);
		border-radius: var(--bs-border-radius-lg);
		box-shadow: var(--shadow-md);
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.compose-options-section-label {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--muted-2);
		padding: 0 0.5rem 0.25rem;
	}

	.compose-options-model-option,
	.compose-options-preset {
		cursor: pointer;
		font-size: 0.875rem;
		transition: background 100ms ease;
	}

	.compose-options-model-option:hover,
	.compose-options-preset:hover {
		background: var(--bs-secondary-bg);
	}

	.compose-options-model-option input[type='radio'],
	.compose-options-preset input[type='radio'] {
		min-height: 0;
		margin: 0;
		width: 14px;
		height: 14px;
		accent-color: var(--accent);
	}

	.compose-options-preset-label {
		flex: 1;
	}

	.compose-options-preset-meta {
		color: var(--muted-2);
		font-size: 0.75rem;
	}

	.compose-options-budget {
		display: flex;
		gap: 0.5rem;
		padding: 0.25rem 0.5rem 0 calc(0.5rem + 14px + 0.5rem);
	}

	.send {
		width: 36px;
		height: 36px;
		min-height: 36px;
		padding: 0;
		margin-left: auto;
	}

	@media (max-width: 600px) {
		.send {
			width: 40px;
			height: 40px;
		}
	}
</style>
