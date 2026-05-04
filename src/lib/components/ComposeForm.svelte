<script lang="ts" module>
	import { THINKING_PRESETS, describeBudget, presetFor } from './thinking-presets';
	export { THINKING_PRESETS, describeBudget, presetFor };
	export type { Preset } from './thinking-presets';
</script>

<script lang="ts">
	import type { ProviderModel } from '$lib/server/providers/types';
	import { sendMessage, setThinkingBudget, abortGeneration, compactContext } from '$lib/conversations.remote';
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { clickOutside } from '$lib/click-outside';
	import type { Preset } from './thinking-presets';

	let {
		conversationId,
		models,
		defaultModel,
		thinkingBudget,
		busy,
		contextUsed = 0,
	}: {
		conversationId: string;
		models: ProviderModel[];
		defaultModel: string;
		thinkingBudget: number | null;
		busy: boolean;
		contextUsed?: number;
	} = $props();

	let formEl: HTMLFormElement | null = $state(null);
	let optionsEl: HTMLDetailsElement | null = $state(null);
	let selectedModel = $state(untrack(() => defaultModel));

	// If the selection is no longer in the configured model list (operator deleted it
	// in /settings, or the conversation was loaded with a stale default),
	// snap to the first available model so submit doesn't 400.
	$effect(() => {
		if (models.length === 0) return;
		if (!models.some((m) => `${m.providerId}/${m.id}` === selectedModel)) {
			selectedModel = models[0] ? `${models[0].providerId}/${models[0].id}` : '';
		}
	});

	let activePresetId = $state(untrack(() => presetFor(thinkingBudget)?.id ?? 'custom'));
	let customInput = $state(
		untrack(() => (presetFor(thinkingBudget) == null && thinkingBudget != null ? thinkingBudget : 0)),
	);
	$effect(() => {
		const matched = presetFor(thinkingBudget);
		activePresetId = matched?.id ?? 'custom';
		if (matched == null && thinkingBudget != null) customInput = thinkingBudget;
	});

	const currentModel = $derived(models.find((m) => `${m.providerId}/${m.id}` === selectedModel));
	const currentLabel = $derived(currentModel?.name ?? selectedModel);
	const budgetSummary = $derived(describeBudget(thinkingBudget));
	const selectedReasoning = $derived(currentModel?.reasoningType);

	// Group models by provider for the dropdown
	const modelsByProvider = $derived(() => {
		const map = new Map<string, ProviderModel[]>();
		for (const m of models) {
			const list = map.get(m.providerId) ?? [];
			list.push(m);
			map.set(m.providerId, list);
		}
		return map;
	});

	function onKeyDown(e: KeyboardEvent) {
		if (e.key !== 'Enter') return;
		if (e.shiftKey) return;
		if (busy) return;
		e.preventDefault();
		formEl?.requestSubmit();
	}

	function pickModel(globalId: string) {
		selectedModel = globalId;
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

	async function onStop() {
		await abortGeneration(conversationId);
		await invalidateAll();
	}

	const contextMax = $derived(currentModel?.maxContextLength ?? 0);
	const contextPct = $derived(contextMax > 0 && contextUsed > 0 ? Math.min(1, contextUsed / contextMax) : 0);
	const showMeter = $derived(contextMax > 0 && contextUsed > 0);

	async function onCompact() {
		if (busy) return;
		const confirmed = window.confirm(
			`Compact context?\n\nThis will summarize your ${contextUsed.toLocaleString()} tokens of conversation history to free up context space. Older messages will be replaced with a summary.\n\nContinue?`,
		);
		if (!confirmed) return;
		const result = await compactContext(conversationId);
		await invalidateAll();
		if (!result.compacted) {
			window.alert('Nothing to compact — the conversation is too short or already compact.');
		}
	}

	function closeOptions() {
		if (optionsEl?.open) optionsEl.open = false;
	}
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
		<details bind:this={optionsEl} class="compose-options" use:clickOutside={closeOptions}>
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
					{#each [...modelsByProvider()] as [providerId, providerModels] (providerId)}
						<div class="compose-options-provider-label">{providerId}</div>
						<ul class="list-unstyled d-flex flex-column gap-0 m-0 p-0">
							{#each providerModels as m (m.id)}
								{@const globalId = `${m.providerId}/${m.id}`}
								<li>
									<label class="compose-options-model-option d-flex align-items-center gap-2 rounded p-2">
										<input
											type="radio"
											name="model"
											value={globalId}
											checked={globalId === selectedModel}
											onchange={() => pickModel(globalId)}
										/>
										<span>{m.name}</span>
									</label>
								</li>
							{/each}
						</ul>
					{/each}
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
		<div class="compose-actions d-flex align-items-center gap-2">
			{#if showMeter}
				<button
					type="button"
					class="context-meter"
					onclick={onCompact}
					disabled={busy}
					title={`Context: ${contextUsed.toLocaleString()} / ${contextMax.toLocaleString()} tokens (${Math.round(contextPct * 100)}%) — click to compact`}
					aria-label={`Context ${Math.round(contextPct * 100)}% full — click to compact`}
				>
					<svg viewBox="0 0 36 36" class="context-ring" aria-hidden="true">
						<circle class="context-ring-bg" cx="18" cy="18" r="15.9155" />
						<circle
							class="context-ring-fill"
							cx="18"
							cy="18"
							r="15.9155"
							stroke-dasharray="{contextPct * 100} {100 - contextPct * 100}"
							stroke-dashoffset="25"
							style="--pct: {contextPct}"
						/>
					</svg>
				</button>
			{/if}
			{#if busy}
				<button type="button" class="send btn btn-primary rounded-circle d-flex align-items-center justify-content-center flex-shrink-0" onclick={onStop} aria-label="Stop">
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width: 18px; height: 18px">
						<rect x="6" y="6" width="12" height="12" rx="2" />
					</svg>
				</button>
			{:else}
				<button type="submit" class="send btn btn-primary rounded-circle d-flex align-items-center justify-content-center flex-shrink-0" disabled={busy} aria-label="Send">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width: 18px; height: 18px">
						<line x1="12" y1="19" x2="12" y2="5" />
						<polyline points="5 12 12 5 19 12" />
					</svg>
				</button>
			{/if}
		</div>
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
		max-height: 60vh;
		overflow-y: auto;
	}

	.compose-options-section-label {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--muted-2);
		padding: 0 0.5rem 0.25rem;
	}

	.compose-options-provider-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--muted-2);
		padding: 0.25rem 0.5rem;
		margin-top: 0.25rem;
	}

	.compose-options-provider-label:first-child {
		margin-top: 0;
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

	.compose-actions {
		margin-left: auto;
		flex-shrink: 0;
	}

	.context-meter {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		background: none;
		border: none;
		cursor: pointer;
		border-radius: 50%;
		flex-shrink: 0;
		transition: opacity 120ms ease;
		opacity: 0.7;
	}

	.context-meter:hover:not([disabled]) {
		opacity: 1;
	}

	.context-meter[disabled] {
		cursor: not-allowed;
		opacity: 0.35;
	}

	.context-ring {
		width: 28px;
		height: 28px;
		transform: rotate(-90deg);
	}

	.context-ring-bg {
		fill: none;
		stroke: var(--border);
		stroke-width: 3;
	}

	.context-ring-fill {
		fill: none;
		stroke-width: 3;
		stroke-linecap: round;
		transition: stroke-dasharray 400ms ease, stroke 400ms ease;
		/* green → yellow → red based on percentage */
		stroke: color-mix(
			in oklch,
			oklch(0.65 0.22 145) calc((1 - var(--pct, 0)) * 100%),
			oklch(0.62 0.25 25) calc(var(--pct, 0) * 100%)
		);
	}

	.send {
		width: 36px;
		height: 36px;
		min-height: 36px;
		padding: 0;
	}

	@media (max-width: 600px) {
		.send {
			width: 40px;
			height: 40px;
		}
	}
</style>
