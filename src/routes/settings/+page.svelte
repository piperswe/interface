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
	} from '$lib/providers.remote';
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
	import {
		confirmOptimisticSubmit,
		confirmToastSubmit,
		justSubmit,
		optimisticSubmit,
		toastSubmit,
	} from '$lib/form-actions';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import type { ProviderType, ReasoningType } from '$lib/server/providers/types';

	let { data }: { data: PageData } = $props();
	const serverTheme = $derived(page.data.theme as 'system' | 'light' | 'dark');
	let optimisticTheme = $state<'system' | 'light' | 'dark' | null>(null);
	const theme = $derived(optimisticTheme ?? serverTheme);
	$effect(() => {
		void serverTheme;
		optimisticTheme = null;
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
	let newProviderGatewayId = $state('');

	// Preset form state
	let selectedPreset = $state('');
	let presetProviderId = $state('');
	let presetApiKey = $state('');
	let presetAccountId = $state('');
	let presetGatewayId = $state('');
	let fetchedPresetModels: { id: string; name: string }[] = $state([]);
	let selectedPresetModels = $state<Set<string>>(new Set());

	// Model form state
	let addModelProviderId = $state<string | null>(null);
	let newModelId = $state('');
	let newModelName = $state('');
	let newModelDescription = $state('');
	let newModelContextLength = $state(128_000);
	let newModelReasoning = $state<ReasoningType | ''>('');
	let newModelInputCost = $state<string>('');
	let newModelOutputCost = $state<string>('');

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
	}

	function providerTypeLabel(type: ProviderType): string {
		switch (type) {
			case 'anthropic':
				return 'Anthropic';
			case 'openai_compatible':
				return 'OpenAI-compatible';
		}
	}
</script>

<div class="settings container py-4">
	<h1 class="mb-4">Settings</h1>

	<!-- Theme -->
	<section class="mb-4">
		<h2 class="h5">Theme</h2>
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
			<select name="value" class="form-select form-select-sm w-auto" value={theme}>
				<option value="system">System</option>
				<option value="light">Light</option>
				<option value="dark">Dark</option>
			</select>
			<button type="submit" class="btn btn-sm btn-primary">Save</button>
		</form>
	</section>

	<!-- Secrets -->
	<section class="mb-4">
		<h2 class="h5">Worker secrets</h2>
		<ul class="list-group">
			{#each data.secretKeys as s (s.name)}
				<li class="list-group-item d-flex justify-content-between align-items-center">
					<code>{s.name}</code>
					<span class="badge {s.configured ? 'text-bg-success' : 'text-bg-secondary'}">
						{s.configured ? 'Configured' : 'Not configured'}
					</span>
				</li>
			{/each}
		</ul>
	</section>

	<!-- Providers & Models -->
	<section class="mb-4">
		<h2 class="h5">Providers & Models</h2>

		{#each visibleProviders as p (p.id)}
			{@const providerModels = data.models
				.filter((m) => m.providerId === p.id && !pendingModels.has(`${m.providerId}/${m.id}`))
				.sort((a, b) => a.sortOrder - b.sortOrder)}
			<div class="card mb-3">
				<div class="card-header d-flex justify-content-between align-items-center">
					<div>
						<strong>{p.id}</strong>
						<span class="badge text-bg-info ms-2">{providerTypeLabel(p.type)}</span>
					</div>
					<div class="d-flex gap-2">
						<button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => (editProviderId = p.id)}>Edit</button>
						<form
							{...deleteProviderAction.for(p.id).enhance(
								confirmOptimisticSubmit(`Delete provider "${p.id}"?`, {
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
				</div>
				<div class="card-body">
					{#if editProviderId === p.id}
						<form {...saveProvider.for(p.id).enhance(toastSubmit('Provider saved'))} class="mb-3">
							<input type="hidden" name="id" value={p.id} />
							<input type="hidden" name="type" value={p.type} />
							<div class="mb-2">
								<input name="api_key" value={p.apiKey ?? ''} placeholder="API key" class="form-control form-control-sm" />
							</div>
							<div class="mb-2">
								<input name="endpoint" value={p.endpoint ?? ''} placeholder="Endpoint" class="form-control form-control-sm" />
							</div>
							<div class="d-flex gap-2">
								<button type="submit" class="btn btn-sm btn-primary">Save</button>
								<button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => (editProviderId = null)}>Cancel</button>
							</div>
						</form>
					{:else}
						{#if p.endpoint}
							<div class="small text-muted mb-2">Endpoint: {p.endpoint}</div>
						{/if}
					{/if}

					<h6 class="mt-3">Models</h6>
					<ul class="list-group list-group-flush">
					{#each providerModels as m, i (m.id)}
						<li class="list-group-item d-flex justify-content-between align-items-center">
							<div>
								<code>{m.id}</code>
								{#if m.name !== m.id}<span class="ms-2">{m.name}</span>{/if}
								{#if m.reasoningType}
									<span class="badge text-bg-secondary ms-1">{m.reasoningType}</span>
								{/if}
								{#if data.defaultModel === `${p.id}/${m.id}`}
									<span class="badge text-bg-success ms-1">Default</span>
								{/if}
								{#if m.inputCostPerMillionTokens != null || m.outputCostPerMillionTokens != null}
									<div class="small text-muted">
										${(m.inputCostPerMillionTokens ?? 0).toFixed(2)} in / ${(m.outputCostPerMillionTokens ?? 0).toFixed(2)} out per 1M tokens
									</div>
								{/if}
							</div>
							<div class="d-flex align-items-center gap-2">
								<form {...reorderProviderModel.for(`up:${p.id}:${m.id}`).enhance(justSubmit)} class="m-0">
									<input type="hidden" name="provider_id" value={p.id} />
									<input type="hidden" name="model_id" value={m.id} />
									<input type="hidden" name="direction" value="up" />
									<button type="submit" class="btn btn-sm btn-link p-0" disabled={i === 0} title="Move up">&#8593;</button>
								</form>
								<form {...reorderProviderModel.for(`down:${p.id}:${m.id}`).enhance(justSubmit)} class="m-0">
									<input type="hidden" name="provider_id" value={p.id} />
									<input type="hidden" name="model_id" value={m.id} />
									<input type="hidden" name="direction" value="down" />
									<button type="submit" class="btn btn-sm btn-link p-0" disabled={i === providerModels.length - 1} title="Move down">&#8595;</button>
								</form>
								{#if data.defaultModel !== `${p.id}/${m.id}`}
									<form {...saveSetting.for(`default_model:${p.id}/${m.id}`).enhance(toastSubmit(`Default model: ${p.id}/${m.id}`))} class="m-0">
										<input type="hidden" name="key" value="default_model" />
										<input type="hidden" name="value" value={`${p.id}/${m.id}`} />
										<button type="submit" class="btn btn-sm btn-link p-0" title="Set as default">&#9733;</button>
									</form>
								{/if}
								<form
									{...deleteProviderModel.for(`${p.id}-${m.id}`).enhance(
										confirmOptimisticSubmit('Delete this model?', {
											apply: () => pendingModelAdd(`${p.id}/${m.id}`),
											revert: () => pendingModelRemove(`${p.id}/${m.id}`),
											successMessage: 'Model deleted',
										}),
									)}
								>
									<input type="hidden" name="provider_id" value={p.id} />
									<input type="hidden" name="model_id" value={m.id} />
									<button type="submit" class="btn btn-sm btn-link text-danger">Remove</button>
								</form>
							</div>
						</li>
					{/each}
					</ul>

					{#if addModelProviderId === p.id}
						<form {...saveProviderModel.for(p.id).enhance(toastSubmit('Model saved'))} class="mt-3 border rounded p-3">
							<input type="hidden" name="provider_id" value={p.id} />
							<div class="mb-2">
								<input name="model_id" bind:value={newModelId} placeholder="Model ID (sent to API)" class="form-control form-control-sm" required />
							</div>
							<div class="mb-2">
								<input name="name" bind:value={newModelName} placeholder="Display name" class="form-control form-control-sm" required />
							</div>
							<div class="mb-2">
								<input name="description" bind:value={newModelDescription} placeholder="Description (optional)" class="form-control form-control-sm" />
							</div>
							<div class="row g-2 mb-2">
								<div class="col">
									<input name="max_context_length" type="number" bind:value={newModelContextLength} placeholder="Context length" class="form-control form-control-sm" />
								</div>
								<div class="col">
									<select name="reasoning_type" class="form-select form-select-sm" bind:value={newModelReasoning}>
										<option value="">No reasoning</option>
										<option value="effort">Effort-based</option>
										<option value="max_tokens">Max tokens</option>
									</select>
								</div>
							</div>
							<div class="row g-2 mb-2">
								<div class="col">
									<input
										name="input_cost_per_million_tokens"
										type="number"
										step="0.0001"
										min="0"
										bind:value={newModelInputCost}
										placeholder="Input $ / 1M tokens (optional)"
										class="form-control form-control-sm"
									/>
								</div>
								<div class="col">
									<input
										name="output_cost_per_million_tokens"
										type="number"
										step="0.0001"
										min="0"
										bind:value={newModelOutputCost}
										placeholder="Output $ / 1M tokens (optional)"
										class="form-control form-control-sm"
									/>
								</div>
							</div>
							<div class="form-text small mb-2">
								Used to estimate cost when the provider does not return one.
							</div>
							<div class="d-flex gap-2">
								<button type="submit" class="btn btn-sm btn-primary">Save model</button>
								<button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => (addModelProviderId = null)}>Cancel</button>
							</div>
						</form>
					{:else}
						<button type="button" class="btn btn-sm btn-outline-primary mt-2" onclick={() => { addModelProviderId = p.id; newModelId = ''; newModelName = ''; newModelDescription = ''; newModelContextLength = 128_000; newModelReasoning = ''; newModelInputCost = ''; newModelOutputCost = ''; }}>+ Add model</button>
					{/if}
				</div>
			</div>
		{/each}

		<!-- Add provider from scratch -->
		{#if showAddProvider}
			<div class="card mb-3">
				<div class="card-header">Add provider</div>
				<div class="card-body">
					<form {...saveProvider.enhance(toastSubmit('Provider added'))}>
						<div class="mb-2">
							<input name="id" bind:value={newProviderId} placeholder="Provider ID (e.g. openrouter)" class="form-control form-control-sm" required pattern="[a-z][a-z0-9_-]*" />
						</div>
						<div class="mb-2">
							<select name="type" class="form-select form-select-sm" bind:value={newProviderType}>
								<option value="openai_compatible">OpenAI-compatible</option>
								<option value="anthropic">Anthropic</option>
							</select>
						</div>
						<div class="mb-2">
							<input name="api_key" bind:value={newProviderApiKey} placeholder="API key" class="form-control form-control-sm" />
						</div>
						{#if newProviderType === 'openai_compatible'}
							<div class="mb-2">
								<input name="endpoint" bind:value={newProviderEndpoint} placeholder="Endpoint (default: https://api.openai.com/v1)" class="form-control form-control-sm" />
							</div>
						{/if}
						<div class="d-flex gap-2">
							<button type="submit" class="btn btn-sm btn-primary">Add provider</button>
							<button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => (showAddProvider = false)}>Cancel</button>
						</div>
					</form>
				</div>
			</div>
		{:else}
			<button type="button" class="btn btn-outline-primary mb-3" onclick={() => (showAddProvider = true)}>+ Add provider</button>
		{/if}

		<!-- Add from preset -->
		<div class="card">
			<div class="card-header">Add from preset</div>
			<div class="card-body">
				<div class="mb-2">
					<select class="form-select form-select-sm" bind:value={selectedPreset}>
						<option value="">Choose a preset...</option>
						{#each data.presets as preset (preset.id)}
							<option value={preset.id}>{preset.label}</option>
						{/each}
					</select>
				</div>
				{#if selectedPreset}
					<div class="mb-2">
						<input bind:value={presetProviderId} placeholder="Provider ID" class="form-control form-control-sm" required />
					</div>
					<div class="mb-2">
						<input bind:value={presetApiKey} placeholder="API key" class="form-control form-control-sm" />
					</div>
					{#if selectedPreset === 'ai-gateway' || selectedPreset === 'workers-ai'}
						<div class="mb-2">
							<input bind:value={presetAccountId} placeholder="Cloudflare Account ID" class="form-control form-control-sm" required />
						</div>
					{/if}
					{#if selectedPreset === 'ai-gateway'}
						<div class="mb-2">
							<input bind:value={presetGatewayId} placeholder="Gateway ID" class="form-control form-control-sm" required />
						</div>
					{/if}
					{#if data.presets.find((p) => p.id === selectedPreset)?.canFetchModels}
						<button type="button" class="btn btn-sm btn-outline-secondary mb-2" onclick={onFetchPresetModels}>Fetch models</button>
						{#if fetchedPresetModels.length > 0}
							<div class="mb-2" style="max-height: 200px; overflow-y: auto;">
								{#each fetchedPresetModels as m (m.id)}
									<label class="d-flex align-items-center gap-2 p-1">
										<input type="checkbox" checked={selectedPresetModels.has(m.id)} onchange={() => togglePresetModel(m.id)} />
										<span class="small">{m.name}</span>
									</label>
								{/each}
							</div>
						{/if}
					{:else}
						<div class="small text-muted mb-2">
							This preset includes {data.presets.find((p) => p.id === selectedPreset)?.defaultModels.length ?? 0} curated models.
						</div>
					{/if}
					<form {...addPresetProvider.enhance(toastSubmit('Preset provider added'))}>
						<input type="hidden" name="id" value={selectedPreset} />
						<input type="hidden" name="provider_id" value={presetProviderId} />
						<input type="hidden" name="api_key" value={presetApiKey} />
						{#if selectedPreset === 'ai-gateway'}
							<input type="hidden" name="endpoint" value={`https://gateway.ai.cloudflare.com/v1/${presetAccountId}/${presetGatewayId}/compat`} />
						{:else if selectedPreset === 'workers-ai'}
							<input type="hidden" name="endpoint" value={`https://api.cloudflare.com/client/v4/accounts/${presetAccountId}/ai/v1`} />
						{/if}
						<input type="hidden" name="model_ids" value={Array.from(selectedPresetModels).join(',')} />
						<button type="submit" class="btn btn-sm btn-primary">Add preset provider</button>
						<button type="button" class="btn btn-sm btn-outline-secondary" onclick={resetPresetForm}>Cancel</button>
					</form>
				{/if}
			</div>
		</div>

		<h6 class="mt-4">Title generation model</h6>
		<form {...titleModelForm.enhance(toastSubmit('Title model saved'))} class="d-flex gap-2 align-items-center">
			<input type="hidden" name="key" value="title_model" />
			<select name="value" class="form-select form-select-sm w-auto">
				<option value="">Auto (first available)</option>
				{#each [...data.models].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.sortOrder - b.sortOrder) as m (`${m.providerId}/${m.id}`)}
					<option value={`${m.providerId}/${m.id}`} selected={data.titleModel === `${m.providerId}/${m.id}`}>
						{m.providerId}/{m.name || m.id}
					</option>
				{/each}
			</select>
			<button type="submit" class="btn btn-sm btn-primary">Save</button>
		</form>
	</section>

	<!-- MCP Servers -->
	<section class="mb-4">
		<h2 class="h5">MCP Servers</h2>
		{#if visibleMcpServers.length === 0}
			<p class="text-muted">No MCP servers configured.</p>
		{:else}
			<ul class="list-group">
				{#each visibleMcpServers as s (s.id)}
					{@const oauthConnected = !!s.oauth?.accessToken}
					<li class="list-group-item d-flex justify-content-between align-items-center">
						<div>
							<strong>{s.name}</strong>
							<span class="badge text-bg-secondary ms-1">{s.transport}</span>
							{#if s.oauth}
								<span class="badge ms-1 {oauthConnected ? 'text-bg-success' : 'text-bg-warning'}">
									{oauthConnected ? 'Connected' : 'Disconnected'}
								</span>
							{/if}
						</div>
						<div class="d-flex gap-2 align-items-center">
							{#if s.oauth && !oauthConnected}
								<a class="btn btn-sm btn-outline-primary" href={`/settings/mcp/${s.id}/connect`}>Connect</a>
							{:else if s.oauth && oauthConnected}
								<form {...disconnectMcpServer.for(s.id).enhance(confirmToastSubmit(`Disconnect "${s.name}"?`, 'MCP server disconnected'))} class="m-0">
									<input type="hidden" name="id" value={s.id} />
									<button type="submit" class="btn btn-sm btn-link">Disconnect</button>
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
								<button type="submit" class="btn btn-sm btn-link text-danger">Delete</button>
							</form>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
		<form {...addMcpServer.enhance(toastSubmit('MCP server added'))} class="mt-2 d-flex gap-2">
			<input name="name" placeholder="Name" class="form-control form-control-sm" required />
			<select name="transport" class="form-select form-select-sm w-auto">
				<option value="http">HTTP</option>
				<option value="sse">SSE</option>
			</select>
			<input name="url" placeholder="URL" class="form-control form-control-sm" required />
			<button type="submit" class="btn btn-sm btn-primary">Add</button>
		</form>

		<div class="mt-3">
			<h6 class="mb-1">Add from catalog</h6>
			<form {...addMcpFromPreset.enhance(toastSubmit('MCP server added'))} class="d-flex gap-2 align-items-start">
				<select name="preset_id" class="form-select form-select-sm" bind:value={selectedMcpPreset} required>
					<option value="">Choose a server…</option>
					{#each data.mcpPresets as preset (preset.id)}
						<option value={preset.id}>{preset.label} · {preset.authMode}</option>
					{/each}
				</select>
				<button type="submit" class="btn btn-sm btn-primary" disabled={!selectedMcpPreset}>Add</button>
			</form>
			{#if selectedMcpPreset}
				{@const p = data.mcpPresets.find((x) => x.id === selectedMcpPreset)}
				{#if p}
					<div class="small text-muted mt-1">{p.description}</div>
				{/if}
			{/if}
		</div>
	</section>

	<!-- Sub-agents -->
	<section class="mb-4">
		<h2 class="h5">Sub-agents</h2>
		{#if visibleSubAgents.length === 0}
			<p class="text-muted">No sub-agents configured.</p>
		{:else}
			<ul class="list-group">
				{#each visibleSubAgents as sa (sa.id)}
					{@const enabled = optimisticSubAgentEnabled.has(sa.id) ? optimisticSubAgentEnabled.get(sa.id)! : sa.enabled}
					<li class="list-group-item d-flex justify-content-between align-items-center">
						<div class="d-flex align-items-center gap-2">
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
								<button type="submit" class="btn btn-sm btn-link p-0">{enabled ? 'On' : 'Off'}</button>
							</form>
							<strong>{sa.name}</strong>
						</div>
						<form
							{...removeSubAgent.for(sa.id).enhance(
								confirmOptimisticSubmit(`Delete sub-agent "${sa.name}"?`, {
									apply: () => pendingSubAgentAdd(sa.id),
									revert: () => pendingSubAgentRemove(sa.id),
									successMessage: 'Sub-agent deleted',
								}),
							)}
						>
							<input type="hidden" name="id" value={sa.id} />
							<button type="submit" class="btn btn-sm btn-link text-danger">Delete</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
		<form {...addSubAgent.enhance(toastSubmit('Sub-agent added'))} class="mt-2 d-flex flex-column gap-2">
			<input name="name" placeholder="Name" class="form-control form-control-sm" required />
			<input name="description" placeholder="Description" class="form-control form-control-sm" required />
			<input name="system_prompt" placeholder="System prompt" class="form-control form-control-sm" required />
			<button type="submit" class="btn btn-sm btn-primary">Add sub-agent</button>
		</form>
	</section>

	<!-- Styles -->
	<section class="mb-4">
		<h2 class="h5">Styles</h2>
		<p class="small text-muted mb-2">Saved system-prompt presets that can be applied per conversation from the chat header.</p>
		{#if visibleStyles.length === 0}
			<p class="text-muted">No styles configured.</p>
		{:else}
			<ul class="list-group">
				{#each visibleStyles as s (s.id)}
					<li class="list-group-item">
						{#if editStyleId === s.id}
							<form {...saveStyle.for(`edit-${s.id}`).enhance(toastSubmit('Style saved'))} class="d-flex flex-column gap-2">
								<input type="hidden" name="id" value={s.id} />
								<input name="name" class="form-control form-control-sm" bind:value={editStyleName} required />
								<textarea name="system_prompt" class="form-control form-control-sm" rows="4" bind:value={editStylePrompt} required></textarea>
								<div class="d-flex gap-2">
									<button type="submit" class="btn btn-sm btn-primary">Save</button>
									<button type="button" class="btn btn-sm btn-outline-secondary" onclick={cancelEditStyle}>Cancel</button>
								</div>
							</form>
						{:else}
							<div class="d-flex justify-content-between align-items-center">
								<div>
									<strong>{s.name}</strong>
									<div class="small text-muted text-truncate" style="max-width: 60ch;">{s.systemPrompt}</div>
								</div>
								<div class="d-flex gap-2">
									<button type="button" class="btn btn-sm btn-link p-0" onclick={() => startEditStyle(s)}>Edit</button>
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
		<form {...addStyle.enhance(toastSubmit('Style added'))} class="mt-2 d-flex flex-column gap-2">
			<input name="name" placeholder="Style name (e.g. Concise, Tutor)" class="form-control form-control-sm" required />
			<textarea name="system_prompt" placeholder="System prompt prepended in front of the global one" class="form-control form-control-sm" rows="3" required></textarea>
			<button type="submit" class="btn btn-sm btn-primary align-self-start">Add style</button>
		</form>
	</section>

	<!-- Memories -->
	<section class="mb-4">
		<h2 class="h5">Memories</h2>
		<p class="small text-muted mb-2">Persistent facts injected into every conversation's system prompt. The model can also save memories itself via the <code>remember</code> tool.</p>
		{#if visibleMemories.length === 0}
			<p class="text-muted">No memories saved.</p>
		{:else}
			<ul class="list-group">
				{#each visibleMemories as m (m.id)}
					<li class="list-group-item d-flex justify-content-between align-items-start gap-2">
						<div>
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
		<form {...addMemory.enhance(toastSubmit('Memory added'))} class="mt-2 d-flex flex-column gap-2">
			<textarea name="content" placeholder="A fact to remember about yourself, your projects, or your preferences." class="form-control form-control-sm" rows="2" required></textarea>
			<button type="submit" class="btn btn-sm btn-primary align-self-start">Add memory</button>
		</form>
	</section>

	<!-- System prompt -->
	<section class="mb-4">
		<h2 class="h5">System prompt</h2>
		<form {...systemPromptForm.enhance(toastSubmit('System prompt saved'))}>
			<input type="hidden" name="key" value="system_prompt" />
			<textarea name="value" class="form-control" rows="6">{data.systemPrompt}</textarea>
			<button type="submit" class="btn btn-sm btn-primary mt-2">Save</button>
		</form>
	</section>

	<!-- User bio -->
	<section class="mb-4">
		<h2 class="h5">User bio</h2>
		<form {...userBioForm.enhance(toastSubmit('User bio saved'))}>
			<input type="hidden" name="key" value="user_bio" />
			<textarea name="value" class="form-control" rows="4">{data.userBio}</textarea>
			<button type="submit" class="btn btn-sm btn-primary mt-2">Save</button>
		</form>
	</section>

	<!-- Tags -->
	<section class="mb-4">
		<h2 class="h5">Tags</h2>
		<p class="small text-muted mb-2">Group conversations by tag. Apply tags from the conversation header (the tag icon).</p>
		{#if data.tags.length === 0}
			<p class="text-muted">No tags yet.</p>
		{:else}
			<ul class="list-group">
				{#each data.tags as t (t.id)}
					<li class="list-group-item d-flex align-items-center justify-content-between gap-2">
						<form {...renameTagForm.for(t.id).enhance(toastSubmit('Tag updated'))} class="d-flex gap-2 align-items-center flex-fill">
							<input type="hidden" name="id" value={t.id} />
							<input type="text" name="name" value={t.name} class="form-control form-control-sm" maxlength="64" />
							<select name="color" class="form-select form-select-sm w-auto">
								<option value="" selected={!t.color}>none</option>
								{#each ['gray','red','orange','amber','green','teal','blue','indigo','purple','pink'] as c}
									<option value={c} selected={t.color === c}>{c}</option>
								{/each}
							</select>
							<button type="submit" class="btn btn-sm btn-outline-secondary">Save</button>
						</form>
						<form {...removeTag.for(t.id).enhance(confirmToastSubmit(`Delete tag "${t.name}"? Conversations keep their content.`, 'Tag deleted'))} class="m-0">
							<input type="hidden" name="id" value={t.id} />
							<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
		<form {...addTag.enhance(toastSubmit('Tag added'))} class="mt-2 d-flex gap-2">
			<input type="text" name="name" placeholder="Tag name" class="form-control form-control-sm" maxlength="64" required />
			<select name="color" class="form-select form-select-sm w-auto">
				<option value="">no color</option>
				{#each ['gray','red','orange','amber','green','teal','blue','indigo','purple','pink'] as c}
					<option value={c}>{c}</option>
				{/each}
			</select>
			<button type="submit" class="btn btn-sm btn-primary">Add tag</button>
		</form>
	</section>

	<!-- Scheduled prompts -->
	<section class="mb-4">
		<h2 class="h5">Scheduled prompts</h2>
		<p class="small text-muted mb-2">Recurring prompts that fire on a Durable Object alarm and post their answer into a target conversation. Times are in UTC.</p>
		{#if data.schedules.length === 0}
			<p class="text-muted">No schedules yet.</p>
		{:else}
			<ul class="list-group">
				{#each data.schedules as s (s.id)}
					<li class="list-group-item d-flex flex-column gap-1">
						<div class="d-flex align-items-center justify-content-between gap-2">
							<div>
								<strong>{s.name}</strong>
								<span class="small text-muted ms-2">
									{s.recurrence}
									{#if s.recurrence === 'daily' && s.timeOfDay != null}
										· {String(Math.floor(s.timeOfDay / 60)).padStart(2, '0')}:{String(s.timeOfDay % 60).padStart(2, '0')} UTC
									{:else if s.recurrence === 'weekly' && s.timeOfDay != null}
										· {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][s.dayOfWeek ?? 0]} {String(Math.floor(s.timeOfDay / 60)).padStart(2, '0')}:{String(s.timeOfDay % 60).padStart(2, '0')} UTC
									{/if}
									{#if s.lastRunAt}· last run {new Date(s.lastRunAt).toLocaleString()}{/if}
									· next {new Date(s.nextRunAt).toLocaleString()}
								</span>
							</div>
							<div class="d-flex gap-2">
								<form {...toggleSchedule.for(s.id).enhance(justSubmit)} class="m-0">
									<input type="hidden" name="id" value={s.id} />
									<input type="hidden" name="enabled" value={String(!s.enabled)} />
									<button type="submit" class="btn btn-sm btn-outline-secondary">{s.enabled ? 'Disable' : 'Enable'}</button>
								</form>
								<form {...runScheduleNow.for(s.id).enhance(toastSubmit('Schedule queued'))} class="m-0">
									<input type="hidden" name="id" value={s.id} />
									<button type="submit" class="btn btn-sm btn-outline-primary">Run now</button>
								</form>
								<form {...removeSchedule.for(s.id).enhance(confirmToastSubmit(`Delete schedule "${s.name}"?`, 'Schedule deleted'))} class="m-0">
									<input type="hidden" name="id" value={s.id} />
									<button type="submit" class="btn btn-sm btn-link text-danger p-0">Delete</button>
								</form>
							</div>
						</div>
						<div class="small text-muted">{s.prompt}</div>
					</li>
				{/each}
			</ul>
		{/if}
		<form {...addSchedule.enhance(toastSubmit('Schedule added'))} class="mt-2 d-flex flex-column gap-2 border rounded p-3">
			<div class="d-flex gap-2 flex-wrap">
				<input type="text" name="name" placeholder="Name (e.g. Morning briefing)" class="form-control form-control-sm" maxlength="64" required />
				<select name="recurrence" class="form-select form-select-sm w-auto" required>
					<option value="hourly">hourly</option>
					<option value="daily" selected>daily</option>
					<option value="weekly">weekly</option>
				</select>
				<input type="time" name="time_of_day" class="form-control form-control-sm w-auto" value="08:00" />
				<select name="day_of_week" class="form-select form-select-sm w-auto" title="Weekly day of week">
					<option value="0">Sun</option>
					<option value="1" selected>Mon</option>
					<option value="2">Tue</option>
					<option value="3">Wed</option>
					<option value="4">Thu</option>
					<option value="5">Fri</option>
					<option value="6">Sat</option>
				</select>
			</div>
			<textarea name="prompt" placeholder="Prompt text (e.g. Give me a morning weather briefing for San Francisco.)" class="form-control form-control-sm" rows="2" required></textarea>
			<div class="d-flex gap-2 align-items-center">
				<label class="small text-muted" for="schedule-target-conversation">Target conversation:</label>
				<select id="schedule-target-conversation" name="target_conversation_id" class="form-select form-select-sm flex-fill">
					<option value="">(create a new one each time)</option>
					{#each data.conversations as c (c.id)}
						<option value={c.id}>{c.title}</option>
					{/each}
				</select>
				<button type="submit" class="btn btn-sm btn-primary">Add schedule</button>
			</div>
		</form>
	</section>

	<!-- Context compaction -->
	<section class="mb-4">
		<h2 class="h5">Context compaction</h2>
		<form {...thresholdForm.enhance(toastSubmit('Threshold saved'))} class="d-flex gap-2 align-items-center mb-2">
			<input type="hidden" name="key" value="context_compaction_threshold" />
			<label class="small" for="ctx-threshold">Threshold (%)</label>
			<input id="ctx-threshold" type="number" name="value" min="0" max="100" value={data.contextCompactionThreshold} class="form-control form-control-sm w-auto" />
			<button type="submit" class="btn btn-sm btn-primary">Save</button>
		</form>
		<form {...summaryTokensForm.enhance(toastSubmit('Summary budget saved'))} class="d-flex gap-2 align-items-center">
			<input type="hidden" name="key" value="context_compaction_summary_tokens" />
			<label class="small" for="ctx-summary">Summary budget (tokens)</label>
			<input id="ctx-summary" type="number" name="value" min="256" value={data.contextCompactionSummaryTokens} class="form-control form-control-sm w-auto" />
			<button type="submit" class="btn btn-sm btn-primary">Save</button>
		</form>
	</section>

	<!-- Web search pricing -->
	<section class="mb-4">
		<h2 class="h5">Web search pricing</h2>
		<form
			{...saveSetting
				.for('kagi_cost_per_1000_searches')
				.enhance(toastSubmit('Kagi search cost saved'))}
			class="d-flex gap-2 align-items-center"
		>
			<input type="hidden" name="key" value="kagi_cost_per_1000_searches" />
			<label class="small" for="kagi-cost">Kagi cost ($ / 1000 searches)</label>
			<input
				id="kagi-cost"
				type="number"
				name="value"
				step="0.01"
				min="0"
				value={data.kagiCostPer1000Searches}
				class="form-control form-control-sm w-auto"
			/>
			<button type="submit" class="btn btn-sm btn-primary">Save</button>
		</form>
		<div class="form-text small">
			Added to per-message cost. Kagi's API charges $25 per 1000 searches by default.
		</div>
	</section>
</div>
