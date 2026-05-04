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
	} from '$lib/settings.remote';
	import { confirmSubmit, confirmToastSubmit, justSubmit, toastSubmit } from '$lib/form-actions';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import type { ProviderType, ReasoningType } from '$lib/server/providers/types';

	let { data }: { data: PageData } = $props();
	const theme = $derived(page.data.theme as 'system' | 'light' | 'dark');

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

	// Provider edit state
	let editProviderId = $state<string | null>(null);


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
		<form {...themeForm.enhance(toastSubmit('Theme saved'))} class="d-flex gap-2 align-items-center">
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
			{#each data.secretKeys as s}
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

		{#each data.providers as p}
			<div class="card mb-3">
				<div class="card-header d-flex justify-content-between align-items-center">
					<div>
						<strong>{p.id}</strong>
						<span class="badge text-bg-info ms-2">{providerTypeLabel(p.type)}</span>
					</div>
					<div class="d-flex gap-2">
						<button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => (editProviderId = p.id)}>Edit</button>
						<form {...deleteProviderAction.for(p.id).enhance(confirmToastSubmit(`Delete provider "${p.id}"?`, `Provider ${p.id} deleted`))}>
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
					{#each data.models.filter((m) => m.providerId === p.id).sort((a, b) => a.sortOrder - b.sortOrder) as m, i (m.id)}
						{@const providerModels = data.models.filter((x) => x.providerId === p.id).sort((a, b) => a.sortOrder - b.sortOrder)}
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
								<form {...deleteProviderModel.for(`${p.id}-${m.id}`).enhance(confirmToastSubmit('Delete this model?', 'Model deleted'))}>
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
							<div class="d-flex gap-2">
								<button type="submit" class="btn btn-sm btn-primary">Save model</button>
								<button type="button" class="btn btn-sm btn-outline-secondary" onclick={() => (addModelProviderId = null)}>Cancel</button>
							</div>
						</form>
					{:else}
						<button type="button" class="btn btn-sm btn-outline-primary mt-2" onclick={() => { addModelProviderId = p.id; newModelId = ''; newModelName = ''; newModelDescription = ''; newModelContextLength = 128_000; newModelReasoning = ''; }}>+ Add model</button>
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
						{#each data.presets as preset}
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
								{#each fetchedPresetModels as m}
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
				{#each data.models.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.sortOrder - b.sortOrder) as m}
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
		{#if data.mcpServers.length === 0}
			<p class="text-muted">No MCP servers configured.</p>
		{:else}
			<ul class="list-group">
				{#each data.mcpServers as s}
					<li class="list-group-item d-flex justify-content-between align-items-center">
						<div>
							<strong>{s.name}</strong>
							<span class="badge text-bg-secondary ms-1">{s.transport}</span>
						</div>
							<form {...removeMcpServer.for(s.id).enhance(confirmToastSubmit(`Delete server "${s.name}"?`, 'MCP server deleted'))}>
							<input type="hidden" name="id" value={s.id} />
							<button type="submit" class="btn btn-sm btn-link text-danger">Delete</button>
						</form>
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
	</section>

	<!-- Sub-agents -->
	<section class="mb-4">
		<h2 class="h5">Sub-agents</h2>
		{#if data.subAgents.length === 0}
			<p class="text-muted">No sub-agents configured.</p>
		{:else}
			<ul class="list-group">
				{#each data.subAgents as sa}
					<li class="list-group-item d-flex justify-content-between align-items-center">
						<div class="d-flex align-items-center gap-2">
							<form {...toggleSubAgent.for(sa.id).enhance(justSubmit)} class="m-0">
								<input type="hidden" name="id" value={sa.id} />
								<input type="hidden" name="enabled" value={String(!sa.enabled)} />
								<button type="submit" class="btn btn-sm btn-link p-0">{sa.enabled ? 'On' : 'Off'}</button>
							</form>
							<strong>{sa.name}</strong>
						</div>
							<form {...removeSubAgent.for(sa.id).enhance(confirmToastSubmit(`Delete sub-agent "${sa.name}"?`, 'Sub-agent deleted'))}>
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
</div>
