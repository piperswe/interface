<script lang="ts">
	import type { PageData } from './$types';
	import {
		saveProvider,
		deleteProviderAction,
		saveProviderModel,
		deleteProviderModel,
		reorderProviderModel,
		addPresetProvider,
		fetchPresetModels,
		searchModelsDev,
		importModelsFromDev,
	} from '$lib/providers.remote';
	import type { ModelsDevEntry } from '$lib/server/providers/modelsDev';
	import {
		saveSetting,
		addMcpServer,
		removeMcpServer,
		addSubAgent,
		removeSubAgent,
		toggleSubAgent,
		addMemory,
		removeMemory,
		addStyle,
		saveStyle,
		removeStyle,
		addMcpFromPreset,
		disconnectMcpServer,
	} from '$lib/settings.remote';
	import { addTag, removeTag, renameTagForm } from '$lib/tags.remote';
	import { addSchedule, removeSchedule, toggleSchedule, runScheduleNow } from '$lib/schedules.remote';
	import { addCustomTool, removeCustomTool, toggleCustomTool } from '$lib/custom-tools.remote';
	import {
		confirmOptimisticSubmit,
		confirmToastSubmit,
		justSubmit,
		optimisticSubmit,
		toastSubmit,
	} from '$lib/form-actions';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import type { ProviderType, ReasoningType } from '$lib/server/providers/types';

	let { data }: { data: PageData } = $props();
	const serverTheme = $derived(page.data.theme as 'system' | 'light' | 'dark');
	let optimisticTheme = $state<'system' | 'light' | 'dark' | null>(null);
	const theme = $derived(optimisticTheme ?? serverTheme);
	$effect(() => {
		void serverTheme;
		optimisticTheme = null;
	});

	// ----- Tab navigation -----
	type TabId = 'general' | 'models' | 'connections' | 'agents' | 'schedules' | 'tools';
	const tabs: { id: TabId; label: string; hint: string }[] = [
		{ id: 'general', label: 'General', hint: 'Theme, prompts & limits' },
		{ id: 'models', label: 'Models', hint: 'Providers & model catalog' },
		{ id: 'connections', label: 'Connections', hint: 'MCP servers' },
		{ id: 'agents', label: 'Agents', hint: 'Sub-agents, styles & memories' },
		{ id: 'schedules', label: 'Schedules & Tags', hint: 'Recurring prompts & tags' },
		{ id: 'tools', label: 'Tools', hint: 'Custom tools (Dynamic Workers)' },
	];
	let activeTab = $state<TabId>('general');

	function setTab(id: TabId) {
		activeTab = id;
		if (typeof window !== 'undefined') {
			history.replaceState(null, '', `#${id}`);
		}
	}

	onMount(() => {
		const hash = window.location.hash.replace('#', '');
		if (tabs.some((t) => t.id === hash)) {
			activeTab = hash as TabId;
		}
	});

	// Optimistic-delete tracking: items in these sets are filtered out of the
	// rendered lists immediately on submit. The reactive cleanup effect below
	// drops ids once the server-side `data` arrays no longer contain them.
	let pendingProviders = $state(new Set<string>());
	let pendingModels = $state(new Set<string>()); // `${providerId}/${modelId}`
	let pendingMcp = $state(new Set<number>());
	let pendingSubAgents = $state(new Set<number>());
	let pendingStyles = $state(new Set<number>());
	let pendingMemories = $state(new Set<number>());
	let pendingCustomTools = $state(new Set<number>());
	let optimisticSubAgentEnabled = $state(new Map<number, boolean>());

	function reconcile<T>(set: Set<T>, present: Set<T>, update: (next: Set<T>) => void) {
		const stale = [...set].filter((id) => !present.has(id));
		if (stale.length === 0) return;
		const next = new Set(set);
		for (const id of stale) next.delete(id);
		update(next);
	}

	$effect(() => {
		reconcile(pendingProviders, new Set(data.providers.map((p) => p.id)), (s) => (pendingProviders = s));
	});
	$effect(() => {
		reconcile(
			pendingModels,
			new Set(data.models.map((m) => `${m.providerId}/${m.id}`)),
			(s) => (pendingModels = s),
		);
	});
	$effect(() => {
		reconcile(pendingMcp, new Set(data.mcpServers.map((s) => s.id)), (s) => (pendingMcp = s));
	});
	$effect(() => {
		reconcile(pendingSubAgents, new Set(data.subAgents.map((s) => s.id)), (s) => (pendingSubAgents = s));
	});
	$effect(() => {
		reconcile(pendingStyles, new Set(data.styles.map((s) => s.id)), (s) => (pendingStyles = s));
	});
	$effect(() => {
		reconcile(pendingMemories, new Set(data.memories.map((m) => m.id)), (s) => (pendingMemories = s));
	});
	$effect(() => {
		reconcile(
			pendingCustomTools,
			new Set(data.customTools.map((t) => t.id)),
			(s) => (pendingCustomTools = s),
		);
	});
	$effect(() => {
		// Drop optimistic toggles once the server reports the same value.
		const stale: number[] = [];
		for (const sa of data.subAgents) {
			if (optimisticSubAgentEnabled.has(sa.id) && optimisticSubAgentEnabled.get(sa.id) === sa.enabled) {
				stale.push(sa.id);
			}
		}
		if (stale.length > 0) {
			const next = new Map(optimisticSubAgentEnabled);
			for (const id of stale) next.delete(id);
			optimisticSubAgentEnabled = next;
		}
	});

	function pendingProviderAdd(id: string) {
		pendingProviders = new Set([...pendingProviders, id]);
	}
	function pendingProviderRemove(id: string) {
		const next = new Set(pendingProviders);
		next.delete(id);
		pendingProviders = next;
	}
	function pendingModelAdd(key: string) {
		pendingModels = new Set([...pendingModels, key]);
	}
	function pendingModelRemove(key: string) {
		const next = new Set(pendingModels);
		next.delete(key);
		pendingModels = next;
	}
	function pendingMcpAdd(id: number) {
		pendingMcp = new Set([...pendingMcp, id]);
	}
	function pendingMcpRemove(id: number) {
		const next = new Set(pendingMcp);
		next.delete(id);
		pendingMcp = next;
	}
	function pendingSubAgentAdd(id: number) {
		pendingSubAgents = new Set([...pendingSubAgents, id]);
	}
	function pendingSubAgentRemove(id: number) {
		const next = new Set(pendingSubAgents);
		next.delete(id);
		pendingSubAgents = next;
	}
	function pendingStyleAdd(id: number) {
		pendingStyles = new Set([...pendingStyles, id]);
	}
	function pendingStyleRemove(id: number) {
		const next = new Set(pendingStyles);
		next.delete(id);
		pendingStyles = next;
	}
	function pendingMemoryAdd(id: number) {
		pendingMemories = new Set([...pendingMemories, id]);
	}
	function pendingMemoryRemove(id: number) {
		const next = new Set(pendingMemories);
		next.delete(id);
		pendingMemories = next;
	}
	function pendingCustomToolAdd(id: number) {
		pendingCustomTools = new Set([...pendingCustomTools, id]);
	}
	function pendingCustomToolRemove(id: number) {
		const next = new Set(pendingCustomTools);
		next.delete(id);
		pendingCustomTools = next;
	}
	function optimisticSubAgentSet(id: number, enabled: boolean) {
		optimisticSubAgentEnabled = new Map(optimisticSubAgentEnabled).set(id, enabled);
	}
	function optimisticSubAgentClear(id: number) {
		const next = new Map(optimisticSubAgentEnabled);
		next.delete(id);
		optimisticSubAgentEnabled = next;
	}

	const visibleProviders = $derived(data.providers.filter((p) => !pendingProviders.has(p.id)));
	const visibleMcpServers = $derived(data.mcpServers.filter((s) => !pendingMcp.has(s.id)));
	const visibleSubAgents = $derived(data.subAgents.filter((s) => !pendingSubAgents.has(s.id)));
	const visibleStyles = $derived(data.styles.filter((s) => !pendingStyles.has(s.id)));
	const visibleMemories = $derived(data.memories.filter((m) => !pendingMemories.has(m.id)));
	const visibleCustomTools = $derived(
		data.customTools.filter((t) => !pendingCustomTools.has(t.id)),
	);

	const providerCount = $derived(visibleProviders.length);
	const visibleModelCount = $derived(
		data.models.filter((m) => !pendingModels.has(`${m.providerId}/${m.id}`)).length,
	);
	const mcpCount = $derived(visibleMcpServers.length);
	const subAgentCount = $derived(visibleSubAgents.length);
	const styleCount = $derived(visibleStyles.length);
	const memoryCount = $derived(visibleMemories.length);
	const tagCount = $derived(data.tags.length);
	const scheduleCount = $derived(data.schedules.length);
	const customToolCount = $derived(visibleCustomTools.length);

	function applyTheme(value: string) {
		if (typeof document !== 'undefined') {
			document.documentElement.setAttribute('data-theme', value);
		}
	}

	const themeForm = saveSetting.for('theme');
	const systemPromptForm = saveSetting.for('system_prompt');
	const userBioForm = saveSetting.for('user_bio');
	const thresholdForm = saveSetting.for('context_compaction_threshold');
	const summaryTokensForm = saveSetting.for('context_compaction_summary_tokens');
	const titleModelForm = saveSetting.for('title_model');

	// Provider form state
	let showAddProvider = $state(false);
	let newProviderId = $state('');
	let newProviderType = $state<ProviderType>('openai_compatible');
	let newProviderApiKey = $state('');
	let newProviderEndpoint = $state('');

	// Preset form state
	let selectedPreset = $state('');
	let presetProviderId = $state('');
	let presetApiKey = $state('');
	let presetAccountId = $state('');
	let presetGatewayId = $state('');
	let fetchedPresetModels: { id: string; name: string }[] = $state([]);
	let selectedPresetModels = $state<Set<string>>(new Set());
	let showPresetForm = $state(false);

	// Model add form state
	let addModelProviderId = $state<string | null>(null);
	let newModelId = $state('');
	let newModelName = $state('');
	let newModelDescription = $state('');
	let newModelContextLength = $state(128_000);
	let newModelReasoning = $state<ReasoningType | ''>('');
	let newModelInputCost = $state<string>('');
	let newModelOutputCost = $state<string>('');
	let newModelSupportsImageInput = $state(false);

	// Model edit form state
	let editModelKey = $state<string | null>(null); // `${providerId}/${modelId}`
	let editModelName = $state('');
	let editModelDescription = $state('');
	let editModelContextLength = $state(128_000);
	let editModelReasoning = $state<ReasoningType | ''>('');
	let editModelInputCost = $state<string>('');
	let editModelOutputCost = $state<string>('');
	let editModelSupportsImageInput = $state(false);

	type ProviderModelLite = {
		id: string;
		providerId: string;
		name: string;
		description: string | null;
		maxContextLength: number;
		reasoningType: ReasoningType | null;
		inputCostPerMillionTokens: number | null;
		outputCostPerMillionTokens: number | null;
		supportsImageInput: boolean;
	};

	function startEditModel(m: ProviderModelLite) {
		editModelKey = `${m.providerId}/${m.id}`;
		editModelName = m.name;
		editModelDescription = m.description ?? '';
		editModelContextLength = m.maxContextLength;
		editModelReasoning = m.reasoningType ?? '';
		editModelInputCost =
			m.inputCostPerMillionTokens != null ? String(m.inputCostPerMillionTokens) : '';
		editModelOutputCost =
			m.outputCostPerMillionTokens != null ? String(m.outputCostPerMillionTokens) : '';
		editModelSupportsImageInput = !!m.supportsImageInput;
		// Cancel the add-model panel when starting an edit so two forms don't collide.
		addModelProviderId = null;
	}
	function cancelEditModel() {
		editModelKey = null;
	}

	// models.dev picker state. Only one provider's picker is open at a time, and
	// the catalog is fetched once per page-mount and cached in-memory.
	let modelsDevPickerProviderId = $state<string | null>(null);
	let modelsDevCatalog = $state<ModelsDevEntry[]>([]);
	let modelsDevLoading = $state(false);
	let modelsDevError = $state<string | null>(null);
	let modelsDevQuery = $state('');
	let modelsDevProviderKeyFilter = $state('');
	let modelsDevIdPrefix = $state('');
	let modelsDevSelected = $state<Set<string>>(new Set());

	async function openModelsDevPicker(providerId: string, providerType: ProviderType) {
		modelsDevPickerProviderId = providerId;
		addModelProviderId = null;
		editModelKey = null;
		modelsDevQuery = '';
		modelsDevProviderKeyFilter = '';
		modelsDevSelected = new Set();
		modelsDevError = null;
		// Anthropic-typed providers talk to Anthropic's API directly, so model
		// ids are bare ("claude-opus-4-6"). openai_compatible providers (OpenRouter,
		// AI Gateway, etc.) generally namespace by vendor, so default the prefix
		// to "<filter>/" once the user picks one.
		modelsDevIdPrefix = providerType === 'anthropic' ? '' : '';
		if (modelsDevCatalog.length === 0) {
			modelsDevLoading = true;
			try {
				modelsDevCatalog = await searchModelsDev();
			} catch (e) {
				modelsDevError = e instanceof Error ? e.message : 'Failed to load models.dev catalog';
			} finally {
				modelsDevLoading = false;
			}
		}
	}

	function closeModelsDevPicker() {
		modelsDevPickerProviderId = null;
	}

	function toggleModelsDevSelected(key: string) {
		const next = new Set(modelsDevSelected);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		modelsDevSelected = next;
	}

	const modelsDevProviderKeys = $derived(
		[...new Set(modelsDevCatalog.map((e) => e.providerKey))].sort(),
	);

	const modelsDevFiltered = $derived.by(() => {
		const q = modelsDevQuery.trim().toLowerCase();
		return modelsDevCatalog
			.filter((e) => !modelsDevProviderKeyFilter || e.providerKey === modelsDevProviderKeyFilter)
			.filter((e) => {
				if (!q) return true;
				return (
					e.modelId.toLowerCase().includes(q) ||
					e.name.toLowerCase().includes(q) ||
					e.providerKey.toLowerCase().includes(q)
				);
			})
			.slice(0, 200);
	});

	$effect(() => {
		// When the user narrows to a single models.dev provider key, suggest a
		// matching id prefix (e.g. `anthropic/`). Don't clobber a custom prefix:
		// only overwrite when the current prefix is empty or is itself one of the
		// known catalog provider keys (a previous auto-suggestion).
		if (!modelsDevProviderKeyFilter) return;
		const looksAutoSet =
			modelsDevIdPrefix === '' ||
			modelsDevProviderKeys.some((k) => modelsDevIdPrefix === `${k}/`);
		if (looksAutoSet) {
			modelsDevIdPrefix = `${modelsDevProviderKeyFilter}/`;
		}
	});

	// Provider edit state
	let editProviderId = $state<string | null>(null);

	// Style edit state
	let editStyleId = $state<number | null>(null);
	let editStyleName = $state('');
	let editStylePrompt = $state('');

	function startEditStyle(s: { id: number; name: string; systemPrompt: string }) {
		editStyleId = s.id;
		editStyleName = s.name;
		editStylePrompt = s.systemPrompt;
	}
	function cancelEditStyle() {
		editStyleId = null;
		editStyleName = '';
		editStylePrompt = '';
	}

	// MCP preset state
	let selectedMcpPreset = $state('');

	async function onFetchPresetModels() {
		if (!selectedPreset) return;
		try {
			const models = await fetchPresetModels({ preset_id: selectedPreset, api_key: presetApiKey });
			fetchedPresetModels = models.map((m) => ({ id: m.id, name: m.name }));
			selectedPresetModels = new Set(models.map((m) => m.id));
		} catch {
			fetchedPresetModels = [];
		}
	}

	function togglePresetModel(id: string) {
		const next = new Set(selectedPresetModels);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedPresetModels = next;
	}

	function resetPresetForm() {
		selectedPreset = '';
		presetProviderId = '';
		presetApiKey = '';
		presetAccountId = '';
		presetGatewayId = '';
		fetchedPresetModels = [];
		selectedPresetModels = new Set();
		showPresetForm = false;
	}

	function providerTypeLabel(type: ProviderType): string {
		switch (type) {
			case 'anthropic':
				return 'Anthropic';
			case 'openai_compatible':
				return 'OpenAI-compatible';
		}
	}

	function formatCost(cost: number | null): string {
		if (cost == null) return '—';
		return cost < 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
	}

	function formatContext(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
		return String(n);
	}

	function formatTimeOfDay(minutes: number | null | undefined): string {
		if (minutes == null) return '';
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
	}
</script>

<div class="settings-shell">
	<header class="settings-header">
		<div class="container py-4">
			<div class="d-flex align-items-end justify-content-between flex-wrap gap-3 mb-3">
				<div>
					<h1 class="mb-1">Settings</h1>
					<p class="text-muted mb-0 small">
						Configure providers, agents, and how Interface behaves across conversations.
					</p>
				</div>
				<div class="d-flex gap-2 align-items-center small text-muted">
					<span class="stat-pill">{providerCount} providers</span>
					<span class="stat-pill">{visibleModelCount} models</span>
					<span class="stat-pill">{mcpCount} MCP</span>
				</div>
			</div>
			<nav class="settings-tabs" aria-label="Settings sections">
				{#each tabs as t (t.id)}
					<button
						type="button"
						class="settings-tab"
						class:active={activeTab === t.id}
						aria-current={activeTab === t.id ? 'page' : undefined}
						onclick={() => setTab(t.id)}
					>
						<span class="tab-label">{t.label}</span>
						<span class="tab-hint">{t.hint}</span>
					</button>
				{/each}
			</nav>
		</div>
	</header>

	<div class="container settings-body py-4">
		{#if activeTab === 'general'}
			<!-- ============ GENERAL ============ -->
			<div class="settings-grid">
				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Appearance</h2>
						<p class="small text-muted mb-0">Light, dark, or follow your OS.</p>
					</div>
					<form
						{...themeForm.enhance(async ({ form, submit }) => {
							const select = form.querySelector('select[name="value"]') as HTMLSelectElement | null;
							const value = select?.value ?? 'system';
							const next: 'system' | 'light' | 'dark' =
								value === 'light' || value === 'dark' ? value : 'system';
							const prev = optimisticTheme ?? serverTheme;
							optimisticTheme = next;
							applyTheme(next);
							try {
								await submit();
							} catch (err) {
								optimisticTheme = prev;
								applyTheme(prev);
								throw err;
							}
						})}
						class="d-flex gap-2 align-items-center"
					>
						<input type="hidden" name="key" value="theme" />
						<div class="theme-toggle" role="radiogroup" aria-label="Theme">
							{#each ['system', 'light', 'dark'] as opt (opt)}
								<label class="theme-option" class:selected={theme === opt}>
									<input
										type="radio"
										name="value"
										value={opt}
										checked={theme === opt}
										onchange={(e) => (e.currentTarget as HTMLInputElement).form?.requestSubmit()}
									/>
									<span class="text-capitalize">{opt}</span>
								</label>
							{/each}
						</div>
					</form>
				</section>

				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">System prompt</h2>
						<p class="small text-muted mb-0">Prepended to every conversation.</p>
					</div>
					<form {...systemPromptForm.enhance(toastSubmit('System prompt saved'))}>
						<input type="hidden" name="key" value="system_prompt" />
						<textarea
							name="value"
							class="form-control"
							rows="6"
							placeholder="You are a helpful assistant…">{data.systemPrompt}</textarea>
						<div class="d-flex justify-content-end mt-2">
							<button type="submit" class="btn btn-sm btn-primary">Save</button>
						</div>
					</form>
				</section>

				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">User bio</h2>
						<p class="small text-muted mb-0">Background info about you that the model can reference.</p>
					</div>
					<form {...userBioForm.enhance(toastSubmit('User bio saved'))}>
						<input type="hidden" name="key" value="user_bio" />
						<textarea
							name="value"
							class="form-control"
							rows="4"
							placeholder="A backend engineer in Brooklyn who…">{data.userBio}</textarea>
						<div class="d-flex justify-content-end mt-2">
							<button type="submit" class="btn btn-sm btn-primary">Save</button>
						</div>
					</form>
				</section>

				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Context compaction</h2>
						<p class="small text-muted mb-0">
							When context fills past the threshold, summarise older turns within a token budget.
						</p>
					</div>
					<div class="d-flex flex-column gap-3">
						<form
							{...thresholdForm.enhance(toastSubmit('Threshold saved'))}
							class="d-flex gap-2 align-items-center flex-wrap"
						>
							<input type="hidden" name="key" value="context_compaction_threshold" />
							<label class="form-label small mb-0" for="ctx-threshold">Threshold</label>
							<div class="input-group input-group-sm w-auto">
								<input
									id="ctx-threshold"
									type="number"
									name="value"
									min="0"
									max="100"
									value={data.contextCompactionThreshold}
									class="form-control"
								/>
								<span class="input-group-text">%</span>
							</div>
							<button type="submit" class="btn btn-sm btn-outline-primary ms-auto">Save</button>
						</form>
						<form
							{...summaryTokensForm.enhance(toastSubmit('Summary budget saved'))}
							class="d-flex gap-2 align-items-center flex-wrap"
						>
							<input type="hidden" name="key" value="context_compaction_summary_tokens" />
							<label class="form-label small mb-0" for="ctx-summary">Summary budget</label>
							<div class="input-group input-group-sm w-auto">
								<input
									id="ctx-summary"
									type="number"
									name="value"
									min="256"
									value={data.contextCompactionSummaryTokens}
									class="form-control"
								/>
								<span class="input-group-text">tokens</span>
							</div>
							<button type="submit" class="btn btn-sm btn-outline-primary ms-auto">Save</button>
						</form>
					</div>
				</section>

				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Web search pricing</h2>
						<p class="small text-muted mb-0">Added to per-message cost when search is used.</p>
					</div>
					<form
						{...saveSetting
							.for('kagi_cost_per_1000_searches')
							.enhance(toastSubmit('Kagi search cost saved'))}
						class="d-flex gap-2 align-items-center flex-wrap"
					>
						<input type="hidden" name="key" value="kagi_cost_per_1000_searches" />
						<label class="form-label small mb-0" for="kagi-cost">Kagi cost</label>
						<div class="input-group input-group-sm w-auto">
							<span class="input-group-text">$</span>
							<input
								id="kagi-cost"
								type="number"
								name="value"
								step="0.01"
								min="0"
								value={data.kagiCostPer1000Searches}
								class="form-control"
								style="width: 7rem;"
							/>
							<span class="input-group-text">/ 1000</span>
						</div>
						<button type="submit" class="btn btn-sm btn-outline-primary ms-auto">Save</button>
					</form>
					<div class="form-text small mt-1">Kagi's API charges $25 per 1000 searches by default.</div>
				</section>

				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Text-to-speech voice</h2>
						<p class="small text-muted mb-0">
							Voice used when reading assistant messages aloud (Workers AI <code>aura-2-en</code>).
						</p>
					</div>
					<form
						{...saveSetting.for('tts_voice').enhance(toastSubmit('TTS voice saved'))}
						class="d-flex gap-2 align-items-center flex-wrap"
					>
						<input type="hidden" name="key" value="tts_voice" />
						<label class="form-label small mb-0" for="tts-voice">Voice</label>
						<select id="tts-voice" name="value" class="form-select form-select-sm w-auto">
							{#each data.ttsVoices as v (v)}
								<option value={v} selected={v === data.ttsVoice}>{v}</option>
							{/each}
						</select>
						<button type="submit" class="btn btn-sm btn-outline-primary ms-auto">Save</button>
					</form>
				</section>

				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Workspace I/O mode</h2>
						<p class="small text-muted mb-0">
							How <code>/workspace</code> inside the sandbox is backed by R2. Snapshot mode is dramatically
							faster for compilers and git but has a ~15s durability window during long-running tasks.
						</p>
					</div>
					<form
						{...saveSetting.for('workspace_io_mode').enhance(toastSubmit('Workspace I/O mode saved'))}
						class="d-flex flex-column gap-2"
					>
						<input type="hidden" name="key" value="workspace_io_mode" />
						<label class="form-check d-flex gap-2 align-items-start mb-0">
							<input
								type="radio"
								name="value"
								value="snapshot"
								class="form-check-input mt-1"
								checked={data.workspaceIoMode === 'snapshot'}
								onchange={(e) => (e.currentTarget as HTMLInputElement).form?.requestSubmit()}
							/>
							<span>
								<strong>Snapshot</strong> <span class="badge text-bg-secondary">recommended</span>
								<span class="d-block small text-muted">
									Hydrate <code>/workspace</code> from R2 on first use; sync deltas back every 15s and
									on every modify-tool boundary. Native ext4 speed for git, npm, compilers.
								</span>
							</span>
						</label>
						<label class="form-check d-flex gap-2 align-items-start mb-0">
							<input
								type="radio"
								name="value"
								value="rclone-mount"
								class="form-check-input mt-1"
								checked={data.workspaceIoMode === 'rclone-mount'}
								onchange={(e) => (e.currentTarget as HTMLInputElement).form?.requestSubmit()}
							/>
							<span>
								<strong>Live mount (rclone)</strong>
								<span class="d-block small text-muted">
									FUSE mount via rclone with a 4 GB local VFS cache. Reads always go through the
									mount; writes are flushed back after each modify-tool call.
								</span>
							</span>
						</label>
					</form>
				</section>

				<section class="settings-card span-2">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Worker secrets</h2>
						<p class="small text-muted mb-0">Set these via <code>wrangler secret put</code>.</p>
					</div>
					<div class="secret-grid">
						{#each data.secretKeys as s (s.name)}
							<div class="secret-row" class:configured={s.configured}>
								<code class="secret-name">{s.name}</code>
								<span class="secret-status">
									<span class="dot"></span>
									{s.configured ? 'Configured' : 'Not set'}
								</span>
							</div>
						{/each}
					</div>
				</section>
			</div>
		{:else if activeTab === 'models'}
			<!-- ============ MODELS ============ -->
			<div class="settings-toolbar">
				<div>
					<h2 class="h5 mb-1">Providers &amp; models</h2>
					<p class="small text-muted mb-0">
						Configure where to call models from and which ones appear in the picker.
					</p>
				</div>
				<div class="d-flex gap-2 flex-wrap">
					<button
						type="button"
						class="btn btn-sm btn-outline-primary"
						onclick={() => {
							showPresetForm = !showPresetForm;
							showAddProvider = false;
						}}
					>
						{showPresetForm ? 'Close preset' : 'Add from preset'}
					</button>
					<button
						type="button"
						class="btn btn-sm btn-primary"
						onclick={() => {
							showAddProvider = !showAddProvider;
							showPresetForm = false;
						}}
					>
						{showAddProvider ? 'Cancel' : '+ Add provider'}
					</button>
				</div>
			</div>

			{#if showAddProvider}
				<div class="settings-card mb-3 add-form">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Add provider</h2>
						<p class="small text-muted mb-0">Configure a custom Anthropic or OpenAI-compatible endpoint.</p>
					</div>
					<form {...saveProvider.enhance(toastSubmit('Provider added'))} class="row g-2">
						<div class="col-md-6">
							<label class="form-label small d-block">
							<span class="d-block mb-1">Provider ID</span>
							<input
								name="id"
								bind:value={newProviderId}
								placeholder="e.g. openrouter"
								class="form-control form-control-sm"
								required
								pattern="[a-z][a-z0-9_-]*"
							/>
							</label>
						</div>
						<div class="col-md-6">
							<label class="form-label small d-block">
							<span class="d-block mb-1">Type</span>
							<select name="type" class="form-select form-select-sm" bind:value={newProviderType}>
								<option value="openai_compatible">OpenAI-compatible</option>
								<option value="anthropic">Anthropic</option>
							</select>
							</label>
						</div>
						<div class="col-md-6">
							<label class="form-label small d-block">
							<span class="d-block mb-1">API key</span>
							<input
								name="api_key"
								bind:value={newProviderApiKey}
								placeholder="sk-…"
								class="form-control form-control-sm"
								type="password"
							/>
							</label>
						</div>
						{#if newProviderType === 'openai_compatible'}
							<div class="col-md-6">
								<label class="form-label small d-block">
								<span class="d-block mb-1">Endpoint</span>
								<input
									name="endpoint"
									bind:value={newProviderEndpoint}
									placeholder="https://api.openai.com/v1"
									class="form-control form-control-sm"
								/>
								</label>
							</div>
						{/if}
						<div class="col-12 d-flex gap-2 justify-content-end mt-2">
							<button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => (showAddProvider = false)}>
								Cancel
							</button>
							<button type="submit" class="btn btn-sm btn-primary">Add provider</button>
						</div>
					</form>
				</div>
			{/if}

			{#if showPresetForm}
				<div class="settings-card mb-3 add-form">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Add from preset</h2>
						<p class="small text-muted mb-0">
							Pick a vendor and we'll preconfigure the endpoint and a curated model list.
						</p>
					</div>
					<div class="mb-2">
						<label class="form-label small d-block">
						<span class="d-block mb-1">Preset</span>
						<select class="form-select form-select-sm" bind:value={selectedPreset}>
							<option value="">Choose a preset…</option>
							{#each data.presets as preset (preset.id)}
								<option value={preset.id}>{preset.label}</option>
							{/each}
						</select>
						</label>
					</div>
					{#if selectedPreset}
						<div class="row g-2">
							<div class="col-md-6">
								<label class="form-label small d-block">
								<span class="d-block mb-1">Provider ID</span>
								<input bind:value={presetProviderId} placeholder="e.g. openrouter" class="form-control form-control-sm" required />
								</label>
							</div>
							<div class="col-md-6">
								<label class="form-label small d-block">
								<span class="d-block mb-1">API key</span>
								<input bind:value={presetApiKey} placeholder="sk-…" class="form-control form-control-sm" type="password" />
								</label>
							</div>
							{#if selectedPreset === 'ai-gateway' || selectedPreset === 'workers-ai'}
								<div class="col-md-6">
									<label class="form-label small d-block">
									<span class="d-block mb-1">Cloudflare Account ID</span>
									<input bind:value={presetAccountId} placeholder="abc123…" class="form-control form-control-sm" required />
									</label>
								</div>
							{/if}
							{#if selectedPreset === 'ai-gateway'}
								<div class="col-md-6">
									<label class="form-label small d-block">
									<span class="d-block mb-1">Gateway ID</span>
									<input bind:value={presetGatewayId} placeholder="my-gateway" class="form-control form-control-sm" required />
									</label>
								</div>
							{/if}
						</div>
						{#if data.presets.find((p) => p.id === selectedPreset)?.canFetchModels}
							<div class="d-flex gap-2 align-items-center mt-2">
								<button type="button" class="btn btn-sm btn-outline-secondary" onclick={onFetchPresetModels}>
									Fetch models
								</button>
								{#if fetchedPresetModels.length > 0}
									<span class="small text-muted">
										{selectedPresetModels.size} of {fetchedPresetModels.length} selected
									</span>
								{/if}
							</div>
							{#if fetchedPresetModels.length > 0}
								<div class="model-checklist mt-2">
									{#each fetchedPresetModels as m (m.id)}
										<label class="model-check">
											<input
												type="checkbox"
												checked={selectedPresetModels.has(m.id)}
												onchange={() => togglePresetModel(m.id)}
											/>
											<span>{m.name}</span>
										</label>
									{/each}
								</div>
							{/if}
						{:else}
							<div class="small text-muted mt-2">
								Includes {data.presets.find((p) => p.id === selectedPreset)?.defaultModels.length ?? 0} curated models.
							</div>
						{/if}
						<form {...addPresetProvider.enhance(toastSubmit('Preset provider added'))} class="d-flex gap-2 justify-content-end mt-3">
							<input type="hidden" name="id" value={selectedPreset} />
							<input type="hidden" name="provider_id" value={presetProviderId} />
							<input type="hidden" name="api_key" value={presetApiKey} />
							{#if selectedPreset === 'ai-gateway'}
								<input
									type="hidden"
									name="endpoint"
									value={`https://gateway.ai.cloudflare.com/v1/${presetAccountId}/${presetGatewayId}/compat`}
								/>
							{:else if selectedPreset === 'workers-ai'}
								<input
									type="hidden"
									name="endpoint"
									value={`https://api.cloudflare.com/client/v4/accounts/${presetAccountId}/ai/v1`}
								/>
							{/if}
							<input type="hidden" name="model_ids" value={Array.from(selectedPresetModels).join(',')} />
							<button type="button" class="btn btn-sm btn-outline-secondary" onclick={resetPresetForm}>Cancel</button>
							<button type="submit" class="btn btn-sm btn-primary">Add provider</button>
						</form>
					{/if}
				</div>
			{/if}

			{#if visibleProviders.length === 0}
				<div class="empty-state">
					<h3 class="h6 mb-2">No providers yet</h3>
					<p class="small text-muted mb-3">
						Add an Anthropic or OpenAI-compatible endpoint, or pick one from the preset list.
					</p>
					<div class="d-flex gap-2 justify-content-center">
						<button type="button" class="btn btn-sm btn-primary" onclick={() => (showAddProvider = true)}>
							+ Add provider
						</button>
						<button type="button" class="btn btn-sm btn-outline-primary" onclick={() => (showPresetForm = true)}>
							Browse presets
						</button>
					</div>
				</div>
			{/if}

			{#each visibleProviders as p (p.id)}
				{@const providerModels = data.models
					.filter((m) => m.providerId === p.id && !pendingModels.has(`${m.providerId}/${m.id}`))
					.sort((a, b) => a.sortOrder - b.sortOrder)}
				<section class="provider-card">
					<header class="provider-head">
						<div class="provider-head-left">
							<div class="provider-title">
								<strong>{p.id}</strong>
								<span class="badge text-bg-secondary">{providerTypeLabel(p.type)}</span>
								<span class="badge text-bg-light">{providerModels.length} model{providerModels.length === 1 ? '' : 's'}</span>
							</div>
							{#if editProviderId !== p.id && p.endpoint}
								<div class="small text-muted text-truncate" style="max-width: 60ch;">{p.endpoint}</div>
							{/if}
						</div>
						<div class="d-flex gap-2 align-items-center">
							<button
								type="button"
								class="btn btn-sm btn-outline-secondary"
								onclick={() => (editProviderId = editProviderId === p.id ? null : p.id)}
							>
								{editProviderId === p.id ? 'Close' : 'Edit'}
							</button>
							<form
								{...deleteProviderAction.for(p.id).enhance(
									confirmOptimisticSubmit(`Delete provider "${p.id}"? Its models will also be removed.`, {
										apply: () => pendingProviderAdd(p.id),
										revert: () => pendingProviderRemove(p.id),
										successMessage: `Provider ${p.id} deleted`,
									}),
								)}
							>
								<input type="hidden" name="id" value={p.id} />
								<button type="submit" class="btn btn-sm btn-outline-danger">Delete</button>
							</form>
						</div>
					</header>

					{#if editProviderId === p.id}
						<form {...saveProvider.for(p.id).enhance(toastSubmit('Provider saved'))} class="provider-edit row g-2">
							<input type="hidden" name="id" value={p.id} />
							<input type="hidden" name="type" value={p.type} />
							<div class="col-md-6">
								<label class="form-label small d-block">
								<span class="d-block mb-1">API key</span>
								<input
									name="api_key"
									value={p.apiKey ?? ''}
									placeholder="API key"
									class="form-control form-control-sm"
									type="password"
								/>
								</label>
							</div>
							<div class="col-md-6">
								<label class="form-label small d-block">
								<span class="d-block mb-1">Endpoint</span>
								<input
									name="endpoint"
									value={p.endpoint ?? ''}
									placeholder="Endpoint"
									class="form-control form-control-sm"
								/>
								</label>
							</div>
							<div class="col-12 d-flex gap-2 justify-content-end mt-2">
								<button
									type="button"
									class="btn btn-sm btn-outline-secondary"
									onclick={() => (editProviderId = null)}
								>
									Cancel
								</button>
								<button type="submit" class="btn btn-sm btn-primary">Save</button>
							</div>
						</form>
					{/if}

					<div class="provider-models">
						{#if providerModels.length === 0}
							<div class="model-empty small text-muted">
								No models yet. Add one below or use a preset.
							</div>
						{/if}
						{#each providerModels as m, i (m.id)}
							{@const isDefault = data.defaultModel === `${p.id}/${m.id}`}
							{@const key = `${p.id}/${m.id}`}
							{#if editModelKey === key}
								<form
									{...saveProviderModel.for(`edit-${key}`).enhance(toastSubmit('Model saved'))}
									class="model-edit"
								>
									<input type="hidden" name="provider_id" value={p.id} />
									<input type="hidden" name="model_id" value={m.id} />
									<div class="d-flex align-items-center gap-2 mb-2">
										<code class="small">{m.id}</code>
										<span class="small text-muted">on {p.id}</span>
									</div>
									<div class="row g-2">
										<div class="col-md-6">
											<label class="form-label small d-block">
											<span class="d-block mb-1">Display name</span>
											<input
												name="name"
												bind:value={editModelName}
												class="form-control form-control-sm"
												required
											/>
											</label>
										</div>
										<div class="col-md-6">
											<label class="form-label small d-block">
											<span class="d-block mb-1">Reasoning</span>
											<select
												name="reasoning_type"
												class="form-select form-select-sm"
												bind:value={editModelReasoning}
											>
												<option value="">No reasoning</option>
												<option value="effort">Effort-based</option>
												<option value="max_tokens">Max tokens</option>
											</select>
											</label>
										</div>
										<div class="col-12">
											<label class="form-label small d-block">
											<span class="d-block mb-1">Description</span>
											<input
												name="description"
												bind:value={editModelDescription}
												placeholder="Optional"
												class="form-control form-control-sm"
											/>
											</label>
										</div>
										<div class="col-md-4">
											<label class="form-label small d-block">
											<span class="d-block mb-1">Context length</span>
											<input
												name="max_context_length"
												type="number"
												bind:value={editModelContextLength}
												class="form-control form-control-sm"
											/>
											</label>
										</div>
										<div class="col-md-4">
											<label class="form-label small d-block">
											<span class="d-block mb-1">Input $ / 1M tokens</span>
											<input
												name="input_cost_per_million_tokens"
												type="number"
												step="0.0001"
												min="0"
												bind:value={editModelInputCost}
												placeholder="optional"
												class="form-control form-control-sm"
											/>
											</label>
										</div>
										<div class="col-md-4">
											<label class="form-label small d-block">
											<span class="d-block mb-1">Output $ / 1M tokens</span>
											<input
												name="output_cost_per_million_tokens"
												type="number"
												step="0.0001"
												min="0"
												bind:value={editModelOutputCost}
												placeholder="optional"
												class="form-control form-control-sm"
											/>
											</label>
										</div>
										<div class="col-12">
											<label class="form-check form-switch small">
												<input
													class="form-check-input"
													type="checkbox"
													name="supports_image_input"
													bind:checked={editModelSupportsImageInput}
												/>
												<span class="form-check-label">Supports image input (multimodal)</span>
											</label>
										</div>
									</div>
									<div class="d-flex gap-2 justify-content-end mt-3">
										<button
											type="button"
											class="btn btn-sm btn-outline-secondary"
											onclick={cancelEditModel}
										>
											Cancel
										</button>
										<button type="submit" class="btn btn-sm btn-primary">Save model</button>
									</div>
								</form>
							{:else}
								<div class="model-row" class:default={isDefault}>
									<div class="model-row-main">
										<div class="model-row-title">
											<code class="model-id">{m.id}</code>
											{#if m.name && m.name !== m.id}
												<span class="model-name">{m.name}</span>
											{/if}
											{#if isDefault}
												<span class="badge text-bg-success">Default</span>
											{/if}
											{#if m.reasoningType}
												<span class="badge text-bg-secondary">{m.reasoningType}</span>
											{/if}
										</div>
										<div class="model-row-meta">
											<span class="meta-chip">
												<span class="meta-label">ctx</span>
												{formatContext(m.maxContextLength)}
											</span>
											<span class="meta-chip">
												<span class="meta-label">in</span>
												{formatCost(m.inputCostPerMillionTokens)} /1M
											</span>
											<span class="meta-chip">
												<span class="meta-label">out</span>
												{formatCost(m.outputCostPerMillionTokens)} /1M
											</span>
											{#if m.description}
												<span class="meta-desc text-truncate" title={m.description}>
													{m.description}
												</span>
											{/if}
										</div>
									</div>
									<div class="model-row-actions">
										<form
											{...reorderProviderModel.for(`up:${p.id}:${m.id}`).enhance(justSubmit)}
											class="m-0"
										>
											<input type="hidden" name="provider_id" value={p.id} />
											<input type="hidden" name="model_id" value={m.id} />
											<input type="hidden" name="direction" value="up" />
											<button
												type="submit"
												class="icon-btn"
												disabled={i === 0}
												title="Move up"
												aria-label="Move up"
											>
												&#8593;
											</button>
										</form>
										<form
											{...reorderProviderModel.for(`down:${p.id}:${m.id}`).enhance(justSubmit)}
											class="m-0"
										>
											<input type="hidden" name="provider_id" value={p.id} />
											<input type="hidden" name="model_id" value={m.id} />
											<input type="hidden" name="direction" value="down" />
											<button
												type="submit"
												class="icon-btn"
												disabled={i === providerModels.length - 1}
												title="Move down"
												aria-label="Move down"
											>
												&#8595;
											</button>
										</form>
										{#if !isDefault}
											<form
												{...saveSetting
													.for(`default_model:${p.id}/${m.id}`)
													.enhance(toastSubmit(`Default model: ${p.id}/${m.id}`))}
												class="m-0"
											>
												<input type="hidden" name="key" value="default_model" />
												<input type="hidden" name="value" value={`${p.id}/${m.id}`} />
												<button
													type="submit"
													class="icon-btn"
													title="Set as default"
													aria-label="Set as default"
												>
													&#9734;
												</button>
											</form>
										{:else}
											<span class="icon-btn solid" title="Default model" aria-hidden="true">&#9733;</span>
										{/if}
										<button
											type="button"
											class="btn btn-sm btn-link p-0"
											onclick={() => startEditModel(m)}
										>
											Edit
										</button>
										<form
											{...deleteProviderModel.for(`${p.id}-${m.id}`).enhance(
												confirmOptimisticSubmit('Delete this model?', {
													apply: () => pendingModelAdd(`${p.id}/${m.id}`),
													revert: () => pendingModelRemove(`${p.id}/${m.id}`),
													successMessage: 'Model deleted',
												}),
											)}
											class="m-0"
										>
											<input type="hidden" name="provider_id" value={p.id} />
											<input type="hidden" name="model_id" value={m.id} />
											<button type="submit" class="btn btn-sm btn-link text-danger p-0">Remove</button>
										</form>
									</div>
								</div>
							{/if}
						{/each}

						{#if addModelProviderId === p.id}
							<form
								{...saveProviderModel.for(`add-${p.id}`).enhance(toastSubmit('Model saved'))}
								class="model-edit add"
							>
								<input type="hidden" name="provider_id" value={p.id} />
								<div class="row g-2">
									<div class="col-md-6">
										<label class="form-label small d-block">
										<span class="d-block mb-1">Model ID</span>
										<input
											name="model_id"
											bind:value={newModelId}
											placeholder="sent to API (e.g. gpt-4o)"
											class="form-control form-control-sm"
											required
										/>
										</label>
									</div>
									<div class="col-md-6">
										<label class="form-label small d-block">
										<span class="d-block mb-1">Display name</span>
										<input
											name="name"
											bind:value={newModelName}
											placeholder="GPT-4o"
											class="form-control form-control-sm"
											required
										/>
										</label>
									</div>
									<div class="col-12">
										<label class="form-label small d-block">
										<span class="d-block mb-1">Description</span>
										<input
											name="description"
											bind:value={newModelDescription}
											placeholder="Optional"
											class="form-control form-control-sm"
										/>
										</label>
									</div>
									<div class="col-md-4">
										<label class="form-label small d-block">
										<span class="d-block mb-1">Context length</span>
										<input
											name="max_context_length"
											type="number"
											bind:value={newModelContextLength}
											class="form-control form-control-sm"
										/>
										</label>
									</div>
									<div class="col-md-4">
										<label class="form-label small d-block">
										<span class="d-block mb-1">Reasoning</span>
										<select name="reasoning_type" class="form-select form-select-sm" bind:value={newModelReasoning}>
											<option value="">No reasoning</option>
											<option value="effort">Effort-based</option>
											<option value="max_tokens">Max tokens</option>
										</select>
										</label>
									</div>
									<div class="col-md-4">
										<label class="form-label small d-block">
											<span class="d-block mb-1">Cost (in / out / 1M)</span>
											<span class="input-group input-group-sm">
												<input
													name="input_cost_per_million_tokens"
													type="number"
													step="0.0001"
													min="0"
													bind:value={newModelInputCost}
													placeholder="in"
													class="form-control"
												/>
												<input
													name="output_cost_per_million_tokens"
													type="number"
													step="0.0001"
													min="0"
													bind:value={newModelOutputCost}
													placeholder="out"
													class="form-control"
												/>
											</span>
										</label>
									</div>
									<div class="col-12">
										<label class="form-check form-switch small">
											<input
												class="form-check-input"
												type="checkbox"
												name="supports_image_input"
												bind:checked={newModelSupportsImageInput}
											/>
											<span class="form-check-label">Supports image input (multimodal)</span>
										</label>
									</div>
								</div>
								<div class="d-flex gap-2 justify-content-end mt-2">
									<button
										type="button"
										class="btn btn-sm btn-outline-secondary"
										onclick={() => (addModelProviderId = null)}
									>
										Cancel
									</button>
									<button type="submit" class="btn btn-sm btn-primary">Save model</button>
								</div>
							</form>
						{:else if modelsDevPickerProviderId === p.id}
							<div class="settings-card models-dev-picker">
								<div class="settings-card-head">
									<h3 class="h6 mb-0">Browse models.dev</h3>
									<p class="small text-muted mb-0">
										Search the public catalog and import models with metadata prefilled.
									</p>
								</div>
								{#if modelsDevLoading}
									<div class="small text-muted">Loading catalog…</div>
								{:else if modelsDevError}
									<div class="alert alert-warning small py-2 mb-2">{modelsDevError}</div>
								{:else}
									<div class="row g-2 mb-2">
										<div class="col-md-6">
											<label class="form-label small d-block">
												<span class="d-block mb-1">Search</span>
												<input
													bind:value={modelsDevQuery}
													placeholder="claude, gpt-5, gemini…"
													class="form-control form-control-sm"
													type="search"
												/>
											</label>
										</div>
										<div class="col-md-3">
											<label class="form-label small d-block">
												<span class="d-block mb-1">Provider</span>
												<select
													bind:value={modelsDevProviderKeyFilter}
													class="form-select form-select-sm"
												>
													<option value="">All providers</option>
													{#each modelsDevProviderKeys as k (k)}
														<option value={k}>{k}</option>
													{/each}
												</select>
											</label>
										</div>
										<div class="col-md-3">
											<label class="form-label small d-block">
												<span class="d-block mb-1">Model ID prefix</span>
												<input
													bind:value={modelsDevIdPrefix}
													placeholder={p.type === 'anthropic' ? '(none)' : 'anthropic/'}
													class="form-control form-control-sm"
												/>
											</label>
										</div>
									</div>
									<div class="model-checklist models-dev-list">
										{#each modelsDevFiltered as entry (`${entry.providerKey}:${entry.modelId}`)}
											{@const key = `${entry.providerKey}:${entry.modelId}`}
											<label class="model-check models-dev-row">
												<input
													type="checkbox"
													checked={modelsDevSelected.has(key)}
													onchange={() => toggleModelsDevSelected(key)}
												/>
												<div class="models-dev-meta">
													<div>
														<strong>{entry.name}</strong>
														<span class="small text-muted ms-2">
															{entry.providerKey}/{entry.modelId}
														</span>
													</div>
													<div class="small text-muted">
														{(entry.contextLength / 1000).toFixed(0)}k ctx
														{#if entry.inputCost != null && entry.outputCost != null}
															· ${entry.inputCost}/${entry.outputCost} per 1M
														{/if}
														{#if entry.supportsImageInput}· image{/if}
														{#if entry.supportsReasoning}· reasoning{/if}
														{#if entry.supportsToolCall}· tools{/if}
														{#if entry.openWeights}· open-weights{/if}
														{#if entry.releaseDate}· {entry.releaseDate}{/if}
													</div>
												</div>
											</label>
										{/each}
										{#if modelsDevFiltered.length === 0}
											<div class="small text-muted py-2">No models match your search.</div>
										{/if}
									</div>
									{#if modelsDevCatalog.length > modelsDevFiltered.length && modelsDevFiltered.length === 200}
										<div class="small text-muted mt-1">
											Showing first 200 results — refine your search to see more.
										</div>
									{/if}
								{/if}
								<form
									{...importModelsFromDev
										.for(`models-dev-${p.id}`)
										.enhance(toastSubmit('Models imported'))}
									class="d-flex gap-2 justify-content-end mt-3 align-items-center"
								>
									<input type="hidden" name="provider_id" value={p.id} />
									<input type="hidden" name="id_prefix" value={modelsDevIdPrefix} />
									<input
										type="hidden"
										name="model_keys"
										value={[...modelsDevSelected].join(',')}
									/>
									<span class="small text-muted me-auto">
										{modelsDevSelected.size} selected
									</span>
									<button
										type="button"
										class="btn btn-sm btn-outline-secondary"
										onclick={closeModelsDevPicker}
									>
										Cancel
									</button>
									<button
										type="submit"
										class="btn btn-sm btn-primary"
										disabled={modelsDevSelected.size === 0}
									>
										Import {modelsDevSelected.size} model{modelsDevSelected.size === 1
											? ''
											: 's'}
									</button>
								</form>
							</div>
						{:else}
							<div class="d-flex gap-2 flex-wrap">
								<button
									type="button"
									class="btn btn-sm btn-outline-primary add-model-btn"
									onclick={() => {
										addModelProviderId = p.id;
										editModelKey = null;
										newModelId = '';
										newModelName = '';
										newModelDescription = '';
										newModelContextLength = 128_000;
										newModelReasoning = '';
										newModelInputCost = '';
										newModelOutputCost = '';
										newModelSupportsImageInput = false;
									}}
								>
									+ Add model
								</button>
								<button
									type="button"
									class="btn btn-sm btn-outline-secondary"
									onclick={() => openModelsDevPicker(p.id, p.type)}
								>
									Browse models.dev
								</button>
							</div>
						{/if}
					</div>
				</section>
			{/each}

			{#if data.models.length > 0}
				<section class="settings-card mt-3">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Title generation</h2>
						<p class="small text-muted mb-0">Used to summarise new conversations into titles.</p>
					</div>
					<form
						{...titleModelForm.enhance(toastSubmit('Title model saved'))}
						class="d-flex gap-2 align-items-center flex-wrap"
					>
						<input type="hidden" name="key" value="title_model" />
						<select name="value" class="form-select form-select-sm flex-fill" style="min-width: 16rem;">
							<option value="">Auto (first available)</option>
							{#each [...data.models].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.sortOrder - b.sortOrder) as m (`${m.providerId}/${m.id}`)}
								<option
									value={`${m.providerId}/${m.id}`}
									selected={data.titleModel === `${m.providerId}/${m.id}`}
								>
									{m.providerId}/{m.name || m.id}
								</option>
							{/each}
						</select>
						<button type="submit" class="btn btn-sm btn-primary">Save</button>
					</form>
				</section>
			{/if}
		{:else if activeTab === 'connections'}
			<!-- ============ CONNECTIONS ============ -->
			<div class="settings-toolbar">
				<div>
					<h2 class="h5 mb-1">MCP servers</h2>
					<p class="small text-muted mb-0">
						Plug in tools, resources, and prompts via the Model Context Protocol.
					</p>
				</div>
			</div>

			{#if visibleMcpServers.length === 0}
				<div class="empty-state">
					<h3 class="h6 mb-2">No MCP servers</h3>
					<p class="small text-muted mb-0">Add a custom URL or pick one from the catalog below.</p>
				</div>
			{:else}
				<div class="mcp-grid">
					{#each visibleMcpServers as s (s.id)}
						{@const oauthConnected = !!s.oauth?.accessToken}
						<div class="mcp-card">
							<div class="mcp-card-head">
								<div class="d-flex flex-column">
									<strong>{s.name}</strong>
									<div class="d-flex gap-1 align-items-center mt-1 flex-wrap">
										<span class="badge text-bg-light">{s.transport}</span>
										{#if s.oauth}
											<span class="badge {oauthConnected ? 'text-bg-success' : 'text-bg-warning'}">
												{oauthConnected ? 'Connected' : 'Disconnected'}
											</span>
										{/if}
									</div>
								</div>
							</div>
							<div class="mcp-card-actions">
								{#if s.oauth && !oauthConnected}
									<a class="btn btn-sm btn-primary" href={`/settings/mcp/${s.id}/connect`}>Connect</a>
								{:else if s.oauth && oauthConnected}
									<form
										{...disconnectMcpServer
											.for(s.id)
											.enhance(confirmToastSubmit(`Disconnect "${s.name}"?`, 'MCP server disconnected'))}
										class="m-0"
									>
										<input type="hidden" name="id" value={s.id} />
										<button type="submit" class="btn btn-sm btn-outline-secondary">Disconnect</button>
									</form>
								{/if}
								<form
									{...removeMcpServer.for(s.id).enhance(
										confirmOptimisticSubmit(`Delete server "${s.name}"?`, {
											apply: () => pendingMcpAdd(s.id),
											revert: () => pendingMcpRemove(s.id),
											successMessage: 'MCP server deleted',
										}),
									)}
									class="m-0"
								>
									<input type="hidden" name="id" value={s.id} />
									<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
								</form>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<div class="settings-grid mt-3">
				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Add custom server</h2>
						<p class="small text-muted mb-0">Connect to any HTTP or SSE MCP endpoint.</p>
					</div>
					<form {...addMcpServer.enhance(toastSubmit('MCP server added'))} class="row g-2">
						<div class="col-md-12">
							<label class="form-label small d-block">
							<span class="d-block mb-1">Name</span>
							<input name="name" placeholder="my-tools" class="form-control form-control-sm" required />
							</label>
						</div>
						<div class="col-md-4">
							<label class="form-label small d-block">
							<span class="d-block mb-1">Transport</span>
							<select name="transport" class="form-select form-select-sm">
								<option value="http">HTTP</option>
								<option value="sse">SSE</option>
							</select>
							</label>
						</div>
						<div class="col-md-8">
							<label class="form-label small d-block">
							<span class="d-block mb-1">URL</span>
							<input name="url" placeholder="https://…" class="form-control form-control-sm" required />
							</label>
						</div>
						<div class="col-12 d-flex justify-content-end">
							<button type="submit" class="btn btn-sm btn-primary">Add server</button>
						</div>
					</form>
				</section>

				<section class="settings-card">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Add from catalog</h2>
						<p class="small text-muted mb-0">Curated, ready-to-go servers.</p>
					</div>
					<form {...addMcpFromPreset.enhance(toastSubmit('MCP server added'))} class="d-flex flex-column gap-2">
						<select name="preset_id" class="form-select form-select-sm" bind:value={selectedMcpPreset} required>
							<option value="">Choose a server…</option>
							{#each data.mcpPresets as preset (preset.id)}
								<option value={preset.id}>{preset.label} · {preset.authMode}</option>
							{/each}
						</select>
						{#if selectedMcpPreset}
							{@const p = data.mcpPresets.find((x) => x.id === selectedMcpPreset)}
							{#if p}
								<div class="small text-muted">{p.description}</div>
							{/if}
						{/if}
						<div class="d-flex justify-content-end">
							<button type="submit" class="btn btn-sm btn-primary" disabled={!selectedMcpPreset}>
								Add
							</button>
						</div>
					</form>
				</section>
			</div>
		{:else if activeTab === 'agents'}
			<!-- ============ AGENTS ============ -->
			<div class="settings-toolbar">
				<div>
					<h2 class="h5 mb-1">Sub-agents <span class="text-muted small fw-normal">({subAgentCount})</span></h2>
					<p class="small text-muted mb-0">
						Specialised assistants invokable via the <code>spawn</code> tool.
					</p>
				</div>
			</div>

			{#if visibleSubAgents.length === 0}
				<div class="empty-state">
					<p class="small text-muted mb-0">No sub-agents configured yet. Add one below.</p>
				</div>
			{:else}
				<ul class="entity-list mb-3">
					{#each visibleSubAgents as sa (sa.id)}
						{@const enabled = optimisticSubAgentEnabled.has(sa.id) ? optimisticSubAgentEnabled.get(sa.id)! : sa.enabled}
						<li class="entity-row">
							<div class="d-flex align-items-center gap-2 flex-fill min-w-0">
								<form
									{...toggleSubAgent.for(sa.id).enhance(
										optimisticSubmit({
											apply: () => optimisticSubAgentSet(sa.id, !enabled),
											revert: () => optimisticSubAgentClear(sa.id),
										}),
									)}
									class="m-0"
								>
									<input type="hidden" name="id" value={sa.id} />
									<input type="hidden" name="enabled" value={String(!enabled)} />
									<button
										type="submit"
										class="toggle-pill"
										class:on={enabled}
										title={enabled ? 'Disable' : 'Enable'}
										aria-pressed={enabled}
									>
										<span class="dot"></span>
										{enabled ? 'On' : 'Off'}
									</button>
								</form>
								<strong class="text-truncate">{sa.name}</strong>
							</div>
							<form
								{...removeSubAgent.for(sa.id).enhance(
									confirmOptimisticSubmit(`Delete sub-agent "${sa.name}"?`, {
										apply: () => pendingSubAgentAdd(sa.id),
										revert: () => pendingSubAgentRemove(sa.id),
										successMessage: 'Sub-agent deleted',
									}),
								)}
								class="m-0"
							>
								<input type="hidden" name="id" value={sa.id} />
								<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}

			<section class="settings-card">
				<div class="settings-card-head">
					<h2 class="h6 mb-0">Add sub-agent</h2>
					<p class="small text-muted mb-0">A name, description, and prompt is all it takes.</p>
				</div>
				<form {...addSubAgent.enhance(toastSubmit('Sub-agent added'))} class="d-flex flex-column gap-2">
					<input name="name" placeholder="Name (e.g. researcher)" class="form-control form-control-sm" required />
					<input name="description" placeholder="Short description" class="form-control form-control-sm" required />
					<textarea name="system_prompt" rows="3" placeholder="System prompt" class="form-control form-control-sm" required></textarea>
					<div class="d-flex justify-content-end">
						<button type="submit" class="btn btn-sm btn-primary">Add sub-agent</button>
					</div>
				</form>
			</section>

			<div class="settings-toolbar mt-4">
				<div>
					<h2 class="h5 mb-1">Styles <span class="text-muted small fw-normal">({styleCount})</span></h2>
					<p class="small text-muted mb-0">
						Saved system-prompt presets, applied per conversation from the chat header.
					</p>
				</div>
			</div>

			{#if visibleStyles.length === 0}
				<div class="empty-state">
					<p class="small text-muted mb-0">No styles yet — try "Concise" or "Tutor" below.</p>
				</div>
			{:else}
				<ul class="entity-list mb-3">
					{#each visibleStyles as s (s.id)}
						<li class="entity-row flex-column align-items-stretch">
							{#if editStyleId === s.id}
								<form
									{...saveStyle.for(`edit-${s.id}`).enhance(toastSubmit('Style saved'))}
									class="d-flex flex-column gap-2"
								>
									<input type="hidden" name="id" value={s.id} />
									<input name="name" class="form-control form-control-sm" bind:value={editStyleName} required />
									<textarea
										name="system_prompt"
										class="form-control form-control-sm"
										rows="4"
										bind:value={editStylePrompt}
										required
									></textarea>
									<div class="d-flex gap-2 justify-content-end">
										<button type="button" class="btn btn-sm btn-outline-secondary" onclick={cancelEditStyle}>
											Cancel
										</button>
										<button type="submit" class="btn btn-sm btn-primary">Save</button>
									</div>
								</form>
							{:else}
								<div class="d-flex justify-content-between align-items-center gap-3">
									<div class="min-w-0">
										<strong>{s.name}</strong>
										<div class="small text-muted text-truncate" style="max-width: 60ch;">
											{s.systemPrompt}
										</div>
									</div>
									<div class="d-flex gap-2 align-items-center">
										<button type="button" class="btn btn-sm btn-link p-0" onclick={() => startEditStyle(s)}>
											Edit
										</button>
										<form
											{...removeStyle.for(s.id).enhance(
												confirmOptimisticSubmit(`Delete style "${s.name}"?`, {
													apply: () => pendingStyleAdd(s.id),
													revert: () => pendingStyleRemove(s.id),
													successMessage: 'Style deleted',
												}),
											)}
											class="m-0"
										>
											<input type="hidden" name="id" value={s.id} />
											<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
										</form>
									</div>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<section class="settings-card">
				<div class="settings-card-head">
					<h2 class="h6 mb-0">Add style</h2>
					<p class="small text-muted mb-0">A short name and the prompt it should prepend.</p>
				</div>
				<form {...addStyle.enhance(toastSubmit('Style added'))} class="d-flex flex-column gap-2">
					<input name="name" placeholder="Style name (e.g. Concise, Tutor)" class="form-control form-control-sm" required />
					<textarea
						name="system_prompt"
						placeholder="System prompt prepended in front of the global one"
						class="form-control form-control-sm"
						rows="3"
						required
					></textarea>
					<div class="d-flex justify-content-end">
						<button type="submit" class="btn btn-sm btn-primary">Add style</button>
					</div>
				</form>
			</section>

			<div class="settings-toolbar mt-4">
				<div>
					<h2 class="h5 mb-1">Memories <span class="text-muted small fw-normal">({memoryCount})</span></h2>
					<p class="small text-muted mb-0">
						Persistent facts injected into every conversation. The model can also save them via the
						<code>remember</code> tool.
					</p>
				</div>
			</div>

			{#if visibleMemories.length === 0}
				<div class="empty-state">
					<p class="small text-muted mb-0">No memories saved.</p>
				</div>
			{:else}
				<ul class="entity-list mb-3">
					{#each visibleMemories as m (m.id)}
						<li class="entity-row align-items-start">
							<div class="min-w-0 flex-fill">
								<div>{m.content}</div>
								<div class="small text-muted">
									{m.type === 'auto' ? 'auto · ' : ''}{new Date(m.createdAt).toLocaleString()}
									{#if m.source}<span> · {m.source}</span>{/if}
								</div>
							</div>
							<form
								{...removeMemory.for(m.id).enhance(
									confirmOptimisticSubmit('Delete this memory?', {
										apply: () => pendingMemoryAdd(m.id),
										revert: () => pendingMemoryRemove(m.id),
										successMessage: 'Memory deleted',
									}),
								)}
								class="m-0"
							>
								<input type="hidden" name="id" value={m.id} />
								<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}

			<section class="settings-card">
				<div class="settings-card-head">
					<h2 class="h6 mb-0">Add memory</h2>
				</div>
				<form {...addMemory.enhance(toastSubmit('Memory added'))} class="d-flex flex-column gap-2">
					<textarea
						name="content"
						placeholder="A fact to remember about yourself, your projects, or your preferences."
						class="form-control form-control-sm"
						rows="2"
						required
					></textarea>
					<div class="d-flex justify-content-end">
						<button type="submit" class="btn btn-sm btn-primary">Add memory</button>
					</div>
				</form>
			</section>
		{:else if activeTab === 'schedules'}
			<!-- ============ SCHEDULES & TAGS ============ -->
			<div class="settings-toolbar">
				<div>
					<h2 class="h5 mb-1">Tags <span class="text-muted small fw-normal">({tagCount})</span></h2>
					<p class="small text-muted mb-0">Group conversations. Apply from the conversation header.</p>
				</div>
			</div>

			{#if data.tags.length === 0}
				<div class="empty-state">
					<p class="small text-muted mb-0">No tags yet.</p>
				</div>
			{:else}
				<ul class="entity-list mb-3">
					{#each data.tags as t (t.id)}
						<li class="entity-row">
							<form
								{...renameTagForm.for(t.id).enhance(toastSubmit('Tag updated'))}
								class="d-flex gap-2 align-items-center flex-fill"
							>
								<input type="hidden" name="id" value={t.id} />
								{#if t.color}
									<span class="tag-swatch" data-color={t.color} aria-hidden="true"></span>
								{/if}
								<input
									type="text"
									name="name"
									value={t.name}
									class="form-control form-control-sm"
									maxlength="64"
								/>
								<select name="color" class="form-select form-select-sm w-auto">
									<option value="" selected={!t.color}>none</option>
									{#each ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'] as c (c)}
										<option value={c} selected={t.color === c}>{c}</option>
									{/each}
								</select>
								<button type="submit" class="btn btn-sm btn-outline-secondary">Save</button>
							</form>
							<form
								{...removeTag
									.for(t.id)
									.enhance(
										confirmToastSubmit(
											`Delete tag "${t.name}"? Conversations keep their content.`,
											'Tag deleted',
										),
									)}
								class="m-0"
							>
								<input type="hidden" name="id" value={t.id} />
								<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}

			<section class="settings-card mb-4">
				<div class="settings-card-head">
					<h2 class="h6 mb-0">Add tag</h2>
				</div>
				<form {...addTag.enhance(toastSubmit('Tag added'))} class="d-flex gap-2 flex-wrap">
					<input
						type="text"
						name="name"
						placeholder="Tag name"
						class="form-control form-control-sm flex-fill"
						style="min-width: 12rem;"
						maxlength="64"
						required
					/>
					<select name="color" class="form-select form-select-sm w-auto">
						<option value="">no color</option>
						{#each ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'] as c (c)}
							<option value={c}>{c}</option>
						{/each}
					</select>
					<button type="submit" class="btn btn-sm btn-primary">Add tag</button>
				</form>
			</section>

			<div class="settings-toolbar">
				<div>
					<h2 class="h5 mb-1">
						Scheduled prompts <span class="text-muted small fw-normal">({scheduleCount})</span>
					</h2>
					<p class="small text-muted mb-0">
						Recurring prompts on a Durable Object alarm. Times in UTC.
					</p>
				</div>
			</div>

			{#if data.schedules.length === 0}
				<div class="empty-state">
					<p class="small text-muted mb-0">No schedules yet.</p>
				</div>
			{:else}
				<ul class="entity-list mb-3">
					{#each data.schedules as s (s.id)}
						<li class="entity-row align-items-start flex-column">
							<div class="d-flex align-items-center justify-content-between gap-2 w-100">
								<div class="min-w-0">
									<strong>{s.name}</strong>
									<div class="small text-muted">
										{s.recurrence}
										{#if s.recurrence === 'daily' && s.timeOfDay != null}
											· {formatTimeOfDay(s.timeOfDay)} UTC
										{:else if s.recurrence === 'weekly' && s.timeOfDay != null}
											· {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.dayOfWeek ?? 0]}
											{formatTimeOfDay(s.timeOfDay)} UTC
										{/if}
										{#if s.lastRunAt}· last run {new Date(s.lastRunAt).toLocaleString()}{/if}
										· next {new Date(s.nextRunAt).toLocaleString()}
									</div>
								</div>
								<div class="d-flex gap-2 flex-shrink-0">
									<form {...toggleSchedule.for(s.id).enhance(justSubmit)} class="m-0">
										<input type="hidden" name="id" value={s.id} />
										<input type="hidden" name="enabled" value={String(!s.enabled)} />
										<button type="submit" class="btn btn-sm btn-outline-secondary">
											{s.enabled ? 'Disable' : 'Enable'}
										</button>
									</form>
									<form
										{...runScheduleNow.for(s.id).enhance(toastSubmit('Schedule queued'))}
										class="m-0"
									>
										<input type="hidden" name="id" value={s.id} />
										<button type="submit" class="btn btn-sm btn-outline-primary">Run now</button>
									</form>
									<form
										{...removeSchedule
											.for(s.id)
											.enhance(confirmToastSubmit(`Delete schedule "${s.name}"?`, 'Schedule deleted'))}
										class="m-0"
									>
										<input type="hidden" name="id" value={s.id} />
										<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
									</form>
								</div>
							</div>
							<div class="small text-muted schedule-prompt">{s.prompt}</div>
						</li>
					{/each}
				</ul>
			{/if}

			<section class="settings-card">
				<div class="settings-card-head">
					<h2 class="h6 mb-0">Add scheduled prompt</h2>
				</div>
				<form {...addSchedule.enhance(toastSubmit('Schedule added'))} class="d-flex flex-column gap-2">
					<div class="row g-2">
						<div class="col-md-6">
							<label class="form-label small d-block">
							<span class="d-block mb-1">Name</span>
							<input
								type="text"
								name="name"
								placeholder="Morning briefing"
								class="form-control form-control-sm"
								maxlength="64"
								required
							/>
							</label>
						</div>
						<div class="col-md-2">
							<label class="form-label small d-block">
							<span class="d-block mb-1">Recurrence</span>
							<select name="recurrence" class="form-select form-select-sm" required>
								<option value="hourly">hourly</option>
								<option value="daily" selected>daily</option>
								<option value="weekly">weekly</option>
							</select>
							</label>
						</div>
						<div class="col-md-2">
							<label class="form-label small d-block">
							<span class="d-block mb-1">Time</span>
							<input type="time" name="time_of_day" class="form-control form-control-sm" value="08:00" />
							</label>
						</div>
						<div class="col-md-2">
							<label class="form-label small d-block">
							<span class="d-block mb-1">Day (weekly)</span>
							<select name="day_of_week" class="form-select form-select-sm">
								<option value="0">Sun</option>
								<option value="1" selected>Mon</option>
								<option value="2">Tue</option>
								<option value="3">Wed</option>
								<option value="4">Thu</option>
								<option value="5">Fri</option>
								<option value="6">Sat</option>
							</select>
							</label>
						</div>
					</div>
					<label class="form-label small mb-0 mt-1 d-block">
					<span class="d-block mb-1">Prompt</span>
					<textarea
						name="prompt"
						placeholder="Give me a morning weather briefing for San Francisco."
						class="form-control form-control-sm"
						rows="2"
						required
					></textarea>
					</label>
					<div class="d-flex gap-2 align-items-center flex-wrap">
						<label class="small text-muted mb-0" for="schedule-target-conversation">Target:</label>
						<select
							id="schedule-target-conversation"
							name="target_conversation_id"
							class="form-select form-select-sm flex-fill"
							style="min-width: 14rem;"
						>
							<option value="">(create a new one each time)</option>
							{#each data.conversations as c (c.id)}
								<option value={c.id}>{c.title}</option>
							{/each}
						</select>
						<button type="submit" class="btn btn-sm btn-primary ms-auto">Add schedule</button>
					</div>
				</form>
			</section>
		{:else if activeTab === 'tools'}
			<!-- ============ TOOLS ============ -->
			<div class="settings-toolbar">
				<div>
					<h2 class="h5 mb-1">
						Custom tools
						<span class="text-muted small fw-normal">({customToolCount})</span>
					</h2>
					<p class="small text-muted mb-0">
						User-defined tools backed by Cloudflare Worker Loader. The agent can also
						read and write these — ask it to "write a tool that…" and it will create one.
					</p>
				</div>
			</div>

			{#if !data.hasWorkerLoader}
				<div class="empty-state">
					<h3 class="h6 mb-2">Worker Loader not configured</h3>
					<p class="small text-muted mb-0">
						Custom tools require the <code>RUN_JS_LOADER</code> binding in
						<code>wrangler.jsonc</code>.
					</p>
				</div>
			{:else if visibleCustomTools.length === 0}
				<div class="empty-state">
					<h3 class="h6 mb-2">No custom tools yet</h3>
					<p class="small text-muted mb-0">
						Create one below, or ask the agent in chat to write one for you.
					</p>
				</div>
			{:else}
				<div class="mcp-grid">
					{#each visibleCustomTools as t (t.id)}
						<div class="mcp-card">
							<div class="mcp-card-head">
								<div class="d-flex flex-column">
									<strong>{t.name}</strong>
									<span class="small text-muted">{t.description}</span>
									<div class="d-flex gap-1 align-items-center mt-1 flex-wrap">
										<span class="badge {t.enabled ? 'text-bg-success' : 'text-bg-secondary'}">
											{t.enabled ? 'Enabled' : 'Disabled'}
										</span>
										<code class="small text-muted">custom_{t.id}_{t.name}</code>
									</div>
								</div>
							</div>
							<div class="mcp-card-actions">
								<a class="btn btn-sm btn-outline-primary" href={`/settings/tools/${t.id}`}>Edit</a>
								<form
									{...toggleCustomTool
										.for(`nav-${t.id}`)
										.enhance(toastSubmit(t.enabled ? 'Tool disabled' : 'Tool enabled'))}
									class="m-0"
								>
									<input type="hidden" name="id" value={t.id} />
									<input type="hidden" name="enabled" value={t.enabled ? 'false' : 'true'} />
									<button type="submit" class="btn btn-sm btn-outline-secondary">
										{t.enabled ? 'Disable' : 'Enable'}
									</button>
								</form>
								<form
									{...removeCustomTool.for(`nav-${t.id}`).enhance(
										confirmOptimisticSubmit(`Delete tool "${t.name}"?`, {
											apply: () => pendingCustomToolAdd(t.id),
											revert: () => pendingCustomToolRemove(t.id),
											successMessage: 'Tool deleted',
										}),
									)}
									class="m-0"
								>
									<input type="hidden" name="id" value={t.id} />
									<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
								</form>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			{#if data.hasWorkerLoader}
				<section class="settings-card mt-3">
					<div class="settings-card-head">
						<h2 class="h6 mb-0">Create a new tool</h2>
						<p class="small text-muted mb-0">
							Starts you with a stub source. Edit the code, schema, and secrets on
							the next page.
						</p>
					</div>
					<form {...addCustomTool.enhance(justSubmit)} class="row g-2">
						<div class="col-md-4">
							<label class="form-label small d-block">
								<span class="d-block mb-1">Name</span>
								<input
									name="name"
									placeholder="current_weather"
									class="form-control form-control-sm"
									required
								/>
							</label>
						</div>
						<div class="col-md-8">
							<label class="form-label small d-block">
								<span class="d-block mb-1">Description</span>
								<input
									name="description"
									placeholder="Get the current weather for a city."
									class="form-control form-control-sm"
									required
								/>
							</label>
						</div>
						<div class="col-12 d-flex justify-content-end">
							<button type="submit" class="btn btn-sm btn-primary">Create &amp; edit</button>
						</div>
					</form>
				</section>
			{/if}
		{/if}
	</div>
</div>

<style>
	.settings-shell {
		display: flex;
		flex-direction: column;
		min-height: 100%;
	}

	.settings-header {
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--bg);
		border-bottom: 1px solid var(--border);
		backdrop-filter: blur(8px);
	}

	.settings-body {
		padding-bottom: 4rem;
	}

	.stat-pill {
		padding: 0.2rem 0.6rem;
		border-radius: 999px;
		background: var(--surface-2);
		border: 1px solid var(--border-soft);
		font-size: 0.78rem;
		white-space: nowrap;
	}

	/* ----- Tabs ----- */
	.settings-tabs {
		display: flex;
		gap: 0.25rem;
		overflow-x: auto;
		margin: 0 -0.25rem;
		padding: 0 0.25rem 0.25rem;
		scrollbar-width: thin;
	}

	.settings-tab {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		padding: 0.55rem 0.9rem;
		border: 1px solid transparent;
		background: transparent;
		color: var(--fg);
		border-radius: 10px 10px 0 0;
		text-align: left;
		min-width: max-content;
		cursor: pointer;
		transition: background 120ms ease, border-color 120ms ease;
	}

	.settings-tab:hover {
		background: var(--surface-2);
	}

	.settings-tab.active {
		background: var(--surface);
		border-color: var(--border);
		border-bottom-color: var(--surface);
		margin-bottom: -1px;
		box-shadow: var(--shadow-sm);
	}

	.tab-label {
		font-weight: 600;
		font-size: 0.95rem;
	}

	.tab-hint {
		font-size: 0.75rem;
		color: var(--muted);
	}

	.settings-tab.active .tab-label {
		color: var(--accent);
	}

	/* ----- Section toolbar ----- */
	.settings-toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	/* ----- Generic settings card ----- */
	.settings-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;
	}

	.settings-grid .span-2 {
		grid-column: span 2;
	}

	@media (max-width: 720px) {
		.settings-grid .span-2 {
			grid-column: auto;
		}
	}

	.settings-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1rem 1.1rem 1.1rem;
		box-shadow: var(--shadow-sm);
	}

	.settings-card-head {
		margin-bottom: 0.7rem;
	}

	.settings-card-head h2 {
		font-weight: 600;
	}

	/* ----- Theme toggle ----- */
	.theme-toggle {
		display: inline-flex;
		gap: 0.25rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		padding: 0.2rem;
		border-radius: 999px;
	}

	.theme-option {
		position: relative;
		padding: 0.35rem 0.9rem;
		border-radius: 999px;
		font-size: 0.85rem;
		cursor: pointer;
		color: var(--muted);
		user-select: none;
		transition: color 120ms ease, background 120ms ease;
	}

	.theme-option input {
		position: absolute;
		opacity: 0;
		inset: 0;
		cursor: pointer;
	}

	.theme-option.selected {
		background: var(--surface);
		color: var(--fg);
		box-shadow: var(--shadow-sm);
	}

	/* ----- Worker secrets ----- */
	.secret-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.5rem;
	}

	.secret-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 0.75rem;
		background: var(--surface-2);
		border: 1px solid var(--border-soft);
		border-radius: 8px;
		font-size: 0.85rem;
	}

	.secret-name {
		color: var(--fg);
		background: transparent;
	}

	.secret-status {
		display: inline-flex;
		gap: 0.4rem;
		align-items: center;
		color: var(--muted);
		font-size: 0.78rem;
	}

	.secret-status .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--muted-2);
	}

	.secret-row.configured .secret-status {
		color: #2c6e3c;
	}

	.secret-row.configured .secret-status .dot {
		background: #2c6e3c;
		box-shadow: 0 0 0 2px rgba(44, 110, 60, 0.18);
	}

	/* ----- Provider card ----- */
	.provider-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		margin-bottom: 1rem;
		box-shadow: var(--shadow-sm);
		overflow: hidden;
	}

	.provider-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.85rem 1.1rem;
		background: var(--surface-2);
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}

	.provider-head-left {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.provider-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.provider-edit {
		padding: 1rem 1.1rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}

	.provider-models {
		padding: 0.5rem 0.5rem 1rem;
	}

	.add-model-btn {
		margin: 0.5rem 0.6rem 0.2rem;
	}

	.model-empty {
		padding: 0.75rem 0.6rem;
	}

	/* ----- Model row ----- */
	.model-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.7rem 0.6rem;
		border-radius: 8px;
		flex-wrap: wrap;
	}

	.model-row + .model-row {
		border-top: 1px solid var(--border-soft);
	}

	.model-row:hover {
		background: var(--surface-2);
	}

	.model-row.default {
		background: var(--accent-soft);
	}

	.model-row-main {
		min-width: 0;
		flex: 1 1 18rem;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.model-row-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		min-width: 0;
	}

	.model-id {
		background: var(--surface-2);
		padding: 0.1rem 0.5rem;
		border-radius: 6px;
		font-size: 0.85rem;
	}

	.model-row.default .model-id {
		background: var(--surface);
	}

	.model-name {
		color: var(--muted);
		font-size: 0.92rem;
	}

	.model-row-meta {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		align-items: center;
		font-size: 0.78rem;
		color: var(--muted);
	}

	.meta-chip {
		display: inline-flex;
		gap: 0.25rem;
		padding: 0.1rem 0.45rem;
		background: var(--surface-2);
		border-radius: 5px;
	}

	.model-row.default .meta-chip {
		background: var(--surface);
	}

	.meta-label {
		color: var(--muted-2);
		text-transform: uppercase;
		font-size: 0.7rem;
		letter-spacing: 0.04em;
	}

	.meta-desc {
		max-width: 32ch;
	}

	.model-row-actions {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}

	.icon-btn {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		width: 1.85rem;
		height: 1.85rem;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		color: var(--muted);
		cursor: pointer;
		font-size: 0.95rem;
		line-height: 1;
		padding: 0;
	}

	.icon-btn:hover:not(:disabled) {
		background: var(--surface);
		border-color: var(--border);
		color: var(--fg);
	}

	.icon-btn.solid {
		color: var(--accent);
	}

	.icon-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.model-edit {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.9rem;
		margin: 0.4rem 0.6rem;
	}

	.model-edit.add {
		border-style: dashed;
		background: var(--surface);
	}

	.add-form {
		border: 1px dashed var(--border);
	}

	.model-checklist {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: 0.25rem;
		max-height: 12rem;
		overflow-y: auto;
		padding: 0.4rem;
		border: 1px solid var(--border-soft);
		border-radius: 6px;
		background: var(--surface-2);
	}

	.model-check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		padding: 0.15rem 0.3rem;
		cursor: pointer;
		border-radius: 4px;
	}

	.model-check:hover {
		background: var(--surface);
	}

	.models-dev-picker {
		border: 1px dashed var(--border);
	}

	.models-dev-list {
		grid-template-columns: 1fr;
		max-height: 22rem;
	}

	.models-dev-row {
		align-items: flex-start;
	}

	.models-dev-meta {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	/* ----- Empty state ----- */
	.empty-state {
		text-align: center;
		padding: 2rem 1rem;
		background: var(--surface);
		border: 1px dashed var(--border);
		border-radius: 12px;
		margin-bottom: 1rem;
	}

	/* ----- MCP cards ----- */
	.mcp-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.mcp-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.8rem 0.95rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		justify-content: space-between;
	}

	.mcp-card-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		justify-content: flex-end;
	}

	/* ----- Generic entity list ----- */
	.entity-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.entity-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		padding: 0.65rem 0.85rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
	}

	.schedule-prompt {
		margin-top: 0.4rem;
		padding: 0.4rem 0.6rem;
		background: var(--surface-2);
		border-radius: 6px;
		width: 100%;
	}

	/* ----- Toggle pill ----- */
	.toggle-pill {
		display: inline-flex;
		gap: 0.4rem;
		align-items: center;
		padding: 0.2rem 0.6rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
		font-size: 0.78rem;
		color: var(--muted);
		cursor: pointer;
	}

	.toggle-pill .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--muted-2);
	}

	.toggle-pill.on {
		color: #2c6e3c;
		background: rgba(44, 110, 60, 0.1);
		border-color: rgba(44, 110, 60, 0.3);
	}

	.toggle-pill.on .dot {
		background: #2c6e3c;
		box-shadow: 0 0 0 2px rgba(44, 110, 60, 0.2);
	}

	/* ----- Tag swatch ----- */
	.tag-swatch {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		flex-shrink: 0;
		border: 1px solid var(--border);
	}

	.tag-swatch[data-color='gray'] {
		background: #9ca3af;
	}
	.tag-swatch[data-color='red'] {
		background: #ef4444;
	}
	.tag-swatch[data-color='orange'] {
		background: #f97316;
	}
	.tag-swatch[data-color='amber'] {
		background: #f59e0b;
	}
	.tag-swatch[data-color='green'] {
		background: #22c55e;
	}
	.tag-swatch[data-color='teal'] {
		background: #14b8a6;
	}
	.tag-swatch[data-color='blue'] {
		background: #3b82f6;
	}
	.tag-swatch[data-color='indigo'] {
		background: #6366f1;
	}
	.tag-swatch[data-color='purple'] {
		background: #a855f7;
	}
	.tag-swatch[data-color='pink'] {
		background: #ec4899;
	}

	@media (max-width: 540px) {
		.tab-hint {
			display: none;
		}

		.settings-tab {
			padding: 0.5rem 0.7rem;
		}

		.model-row-actions {
			flex-wrap: wrap;
		}
	}
</style>
