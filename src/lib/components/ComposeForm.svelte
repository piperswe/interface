<script lang="ts" module>
	import { THINKING_PRESETS, describeBudget, presetFor } from './thinking-presets';
	export { THINKING_PRESETS, describeBudget, presetFor };
	export type { Preset } from './thinking-presets';
</script>

<script lang="ts">
	import type { ProviderModel } from '$lib/server/providers/types';
	import { sendMessage, setThinkingBudget, abortGeneration, compactContext } from '$lib/conversations.remote';
	import { invalidateAll } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import { clickOutside } from '$lib/click-outside';
	import type { Preset } from './thinking-presets';
	import type { Recorder } from '$lib/speech-recognition.client';
	import type {
		ConversationMode,
		ConversationModeSnapshot,
	} from '$lib/conversation-mode.client';
	import ConversationModeButton from './ConversationModeButton.svelte';

	let {
		conversationId,
		models,
		defaultModel,
		thinkingBudget,
		busy,
		contextUsed = 0,
		conversationMode,
		onOptimisticSubmit,
		onOptimisticRevert,
	}: {
		conversationId: string;
		models: ProviderModel[];
		defaultModel: string;
		thinkingBudget: number | null;
		busy: boolean;
		contextUsed?: number;
		conversationMode?: ConversationMode | null;
		onOptimisticSubmit?: (content: string, model: string) => void;
		onOptimisticRevert?: () => void;
	} = $props();

	let conversationModeSnapshot = $state<ConversationModeSnapshot | null>(null);
	$effect(() => {
		const cm = conversationMode;
		if (!cm) {
			conversationModeSnapshot = null;
			return;
		}
		return cm.subscribe((s) => {
			conversationModeSnapshot = s;
		});
	});
	const conversationModeActive = $derived(conversationModeSnapshot?.active === true);

	let formEl: HTMLFormElement | null = $state(null);
	let textareaEl: HTMLTextAreaElement | null = $state(null);
	let optionsEl: HTMLDetailsElement | null = $state(null);
	let fileInputEl: HTMLInputElement | null = $state(null);
	let selectedModel = $state(untrack(() => defaultModel));

	// Tracked attachments for the next submit. `path` is set once the upload
	// completes; `error` is set if the upload fails. We render chips for each
	// item so the user sees uploads in flight, completed, and any failures.
	type Attachment = {
		key: string;
		filename: string;
		status: 'uploading' | 'done' | 'error';
		path?: string;
		size?: number;
		error?: string;
	};
	let attachments = $state<Attachment[]>([]);
	let isDraggingOver = $state(false);

	async function uploadFile(file: File): Promise<void> {
		const key = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const entry: Attachment = { key, filename: file.name, status: 'uploading' };
		attachments = [...attachments, entry];
		try {
			const url = `/c/${conversationId}/sandbox/upload?filename=${encodeURIComponent(file.name)}`;
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': file.type || 'application/octet-stream' },
				body: file,
			});
			if (!res.ok) {
				const text = await res.text().catch(() => `${res.status} ${res.statusText}`);
				throw new Error(text || `upload failed (${res.status})`);
			}
			const data = (await res.json()) as { path: string; size: number };
			attachments = attachments.map((a) =>
				a.key === key ? { ...a, status: 'done', path: data.path, size: data.size } : a,
			);
		} catch (err) {
			attachments = attachments.map((a) =>
				a.key === key
					? { ...a, status: 'error', error: err instanceof Error ? err.message : String(err) }
					: a,
			);
		}
	}

	function onPickFiles(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = input.files;
		if (!files) return;
		for (const f of Array.from(files)) void uploadFile(f);
		// Reset so picking the same file twice still triggers change.
		input.value = '';
	}

	function onDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		isDraggingOver = true;
	}
	function onDragLeave() {
		isDraggingOver = false;
	}
	function onDrop(e: DragEvent) {
		if (!e.dataTransfer?.files?.length) return;
		e.preventDefault();
		isDraggingOver = false;
		for (const f of Array.from(e.dataTransfer.files)) void uploadFile(f);
	}

	function removeAttachment(key: string) {
		attachments = attachments.filter((a) => a.key !== key);
	}

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function buildAttachmentsTrailer(): string {
		const ready = attachments.filter((a) => a.status === 'done' && a.path);
		if (ready.length === 0) return '';
		const lines = ready.map((a) => a.path).join('\n');
		return `\n\n<attachments>\n${lines}\n</attachments>`;
	}

	// Focus the textarea whenever the conversation changes — covers the
	// optimistic-create flow where we navigate into a fresh `/c/<id>` and want
	// the user to be able to start typing immediately, plus the regular case
	// of switching between conversations via the sidebar.
	$effect(() => {
		void conversationId;
		const el = textareaEl;
		if (!el || busy) return;
		queueMicrotask(() => {
			el.focus();
			resizeTextarea();
		});
	});

	function resizeTextarea() {
		const el = textareaEl;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${el.scrollHeight}px`;
	}

	// Sync selectedModel when defaultModel changes externally (e.g. model_switch tool).
	$effect(() => {
		selectedModel = defaultModel;
	});

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

	type RecState = 'idle' | 'recording' | 'transcribing' | 'error';
	let recState = $state<RecState>('idle');
	let recError = $state<string | null>(null);
	let recSupported = $state(false);
	let recorder: Recorder | null = null;
	let errorResetTimer: ReturnType<typeof setTimeout> | null = null;

	onMount(async () => {
		const mod = await import('$lib/speech-recognition.client');
		recSupported = mod.isSpeechRecognitionSupported();
	});

	function clearErrorLater() {
		if (errorResetTimer) clearTimeout(errorResetTimer);
		errorResetTimer = setTimeout(() => {
			if (recState === 'error') {
				recState = 'idle';
				recError = null;
			}
			errorResetTimer = null;
		}, 3000);
	}

	function setRecError(message: string) {
		recError = message;
		recState = 'error';
		clearErrorLater();
	}

	function insertTranscript(text: string) {
		if (!text) return;
		const ta = textareaEl;
		if (!ta) return;
		const start = ta.selectionStart ?? ta.value.length;
		const end = ta.selectionEnd ?? ta.value.length;
		const before = ta.value.slice(0, start);
		const after = ta.value.slice(end);
		const needsLeadSpace = before.length > 0 && !/\s$/.test(before) && !/^\s/.test(text);
		const insert = (needsLeadSpace ? ' ' : '') + text;
		ta.value = before + insert + after;
		const cursor = (before + insert).length;
		ta.selectionStart = ta.selectionEnd = cursor;
		ta.focus();
		resizeTextarea();
	}

	async function onMicClick() {
		if (busy) return;
		const mod = await import('$lib/speech-recognition.client');
		if (recState === 'idle' || recState === 'error') {
			recError = null;
			try {
				recorder = new mod.Recorder();
				await recorder.start();
				recState = 'recording';
			} catch (err) {
				recorder?.cancel();
				recorder = null;
				setRecError(mod.explainMicError(err));
			}
			return;
		}
		if (recState === 'recording') {
			const r = recorder;
			if (!r) {
				recState = 'idle';
				return;
			}
			recState = 'transcribing';
			try {
				const blob = await r.stop();
				const text = await mod.transcribe(blob);
				insertTranscript(text);
				recState = 'idle';
			} catch (err) {
				setRecError(err instanceof Error ? err.message : String(err));
			} finally {
				recorder = null;
			}
		}
	}

	const micGlyph = $derived(
		recState === 'recording' ? '⏺' : recState === 'transcribing' ? '⏳' : recState === 'error' ? '⚠' : '🎤',
	);
	const micLabel = $derived(
		recState === 'recording'
			? 'Stop recording'
			: recState === 'transcribing'
				? 'Transcribing…'
				: recState === 'error'
					? 'Retry dictation'
					: 'Dictate message',
	);
</script>

<form
	bind:this={formEl}
	{...sendMessage.for(conversationId).enhance(async ({ form, submit }) => {
		const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="content"]');
		const rawContent = textarea?.value ?? '';
		const trailer = buildAttachmentsTrailer();
		// SvelteKit captures FormData at submit-event time, before this
		// callback runs — so we rely on the hidden `attachments_trailer`
		// input below being up-to-date via Svelte reactivity. The optimistic
		// echo to the user includes the trailer too so it stays in sync with
		// what the server will store.
		const trimmed = (rawContent + trailer).trim();
		const optimistic = trimmed.length > 0 && onOptimisticSubmit != null;
		const previousAttachments = attachments;
		if (optimistic) {
			onOptimisticSubmit!(trimmed, selectedModel);
			if (textarea) {
				textarea.value = '';
				resizeTextarea();
			}
			attachments = [];
		}
		try {
			await submit();
			if (!optimistic) {
				if (textarea) {
					textarea.value = '';
					resizeTextarea();
				}
				attachments = [];
			}
		} catch (err) {
			if (optimistic) {
				onOptimisticRevert?.();
				if (textarea) {
					textarea.value = rawContent;
					resizeTextarea();
				}
				attachments = previousAttachments;
			}
			throw err;
		}
	})}
	class="compose d-flex flex-column gap-2 bg-body border rounded-4 p-2 ps-3"
	class:dragover={isDraggingOver}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	<input type="hidden" name="conversationId" value={conversationId} />
	<input type="hidden" name="attachments_trailer" value={buildAttachmentsTrailer()} />
	<textarea
		bind:this={textareaEl}
		name="content"
		placeholder={conversationModeActive ? 'Conversation mode — speak instead' : 'Send a message…'}
		required={attachments.filter((a) => a.status === 'done').length === 0 && !conversationModeActive}
		disabled={busy}
		readonly={conversationModeActive}
		rows={1}
		onkeydown={onKeyDown}
		oninput={resizeTextarea}
		class="form-control border-0 shadow-none bg-transparent p-1"
		class:cm-readonly={conversationModeActive}
	></textarea>
	{#if attachments.length > 0}
		<ul class="attachment-list list-unstyled m-0 p-0 d-flex flex-wrap gap-2">
			{#each attachments as a (a.key)}
				<li class="attachment-chip" class:error={a.status === 'error'} title={a.error ?? a.path ?? ''}>
					{#if a.status === 'uploading'}
						<span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
					{:else if a.status === 'error'}
						<span aria-hidden="true">⚠</span>
					{:else}
						<span aria-hidden="true">📎</span>
					{/if}
					<span class="attachment-name text-truncate">{a.filename}</span>
					{#if a.status === 'done' && a.size != null}
						<span class="attachment-size text-muted small">{fmtBytes(a.size)}</span>
					{/if}
					<button
						type="button"
						class="attachment-remove"
						onclick={() => removeAttachment(a.key)}
						aria-label="Remove attachment {a.filename}"
					>×</button>
				</li>
			{/each}
		</ul>
	{/if}
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
			<input
				type="file"
				bind:this={fileInputEl}
				multiple
				class="visually-hidden"
				onchange={onPickFiles}
			/>
			<button
				type="button"
				class="attach-button"
				onclick={() => fileInputEl?.click()}
				disabled={busy}
				aria-label="Attach files"
				title="Attach files"
			>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width: 18px; height: 18px">
					<path d="M21.44 11.05l-9.19 9.19a6 6 0 1 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48"/>
				</svg>
			</button>
			{#if recSupported && !conversationModeActive}
				<button
					type="button"
					class="mic-button"
					class:recording={recState === 'recording'}
					class:transcribing={recState === 'transcribing'}
					class:error={recState === 'error'}
					onclick={onMicClick}
					disabled={busy || recState === 'transcribing'}
					aria-label={micLabel}
					aria-pressed={recState === 'recording'}
					title={recError ?? micLabel}
				>
					<span aria-hidden="true">{micGlyph}</span>
				</button>
			{/if}
			{#if conversationMode}
				<ConversationModeButton mode={conversationMode} disabled={busy && !conversationModeActive} />
			{/if}
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
		/* 10 lines (1.5em line-height) + vertical padding (p-1 → 0.5rem total). */
		max-height: calc(1.5em * 10 + 0.5rem);
		overflow-y: auto;
		resize: none;
		font-family: inherit;
		font-size: 1rem;
		line-height: 1.5;
	}

	.compose textarea::placeholder {
		color: var(--muted-2);
	}

	.compose textarea.cm-readonly {
		opacity: 0.55;
		cursor: default;
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

	.compose.dragover {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent);
	}

	.attachment-list {
		max-height: 8rem;
		overflow-y: auto;
	}

	.attachment-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.5rem;
		font-size: 0.8125rem;
		background: var(--bs-secondary-bg);
		border: 1px solid var(--border-soft);
		border-radius: 999px;
		max-width: 220px;
	}

	.attachment-chip.error {
		background: var(--error-bg, rgba(255, 0, 0, 0.05));
		color: var(--error-fg, #c00);
		border-color: var(--error-fg, #c00);
	}

	.attachment-name {
		max-width: 140px;
	}

	.attachment-size {
		font-variant-numeric: tabular-nums;
	}

	.attachment-remove {
		background: none;
		border: none;
		padding: 0;
		font-size: 1rem;
		line-height: 1;
		color: var(--muted);
		cursor: pointer;
	}

	.attachment-remove:hover {
		color: var(--fg);
	}

	.attach-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}

	.attach-button:hover:not([disabled]) {
		background: var(--bs-secondary-bg);
		color: var(--fg);
	}

	.attach-button[disabled] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.mic-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
		font-size: 0.95rem;
		line-height: 1;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 999px;
		color: var(--muted);
		cursor: pointer;
		transition: background 120ms ease, color 120ms ease;
	}

	.mic-button:hover:not([disabled]) {
		background: var(--bs-secondary-bg);
		color: var(--fg);
	}

	.mic-button[disabled] {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.mic-button.recording {
		color: #c00;
		background: var(--bs-secondary-bg);
		animation: mic-pulse 1.1s ease-in-out infinite;
	}

	.mic-button.transcribing {
		opacity: 0.7;
	}

	.mic-button.error {
		color: var(--error-fg, #c00);
	}

	@keyframes mic-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(204, 0, 0, 0.45); }
		50% { box-shadow: 0 0 0 6px rgba(204, 0, 0, 0); }
	}
</style>
