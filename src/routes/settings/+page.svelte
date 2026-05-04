<script lang="ts">
	import type { PageData } from './$types';
	import {
		saveSetting,
		addMcpServer,
		removeMcpServer,
		addSubAgent,
		removeSubAgent,
		toggleSubAgent,
	} from '$lib/settings.remote';
	import { confirmSubmit, justSubmit } from '$lib/form-actions';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import type { ReasoningType } from '$lib/server/models/config';

	let { data }: { data: PageData } = $props();
	const theme = $derived(page.data.theme as 'system' | 'light' | 'dark');

	const themeForm = saveSetting.for('theme');
	const systemPromptForm = saveSetting.for('system_prompt');
	const userBioForm = saveSetting.for('user_bio');
	const modelListForm = saveSetting.for('model_list');
	const thresholdForm = saveSetting.for('context_compaction_threshold');
	const summaryTokensForm = saveSetting.for('context_compaction_summary_tokens');
	const cfAIGatewayIdForm = saveSetting.for('cf_ai_gateway_id');

	let models = $state(untrack(() => data.modelList.map((m) => ({ slug: m.slug, label: m.label, reasoning: m.reasoning as ReasoningType | undefined }))));

	const serializedModels = $derived(
		JSON.stringify(
			models
				.filter((m) => m.slug.trim())
				.map((m) => {
					const entry: { slug: string; label: string; reasoning?: ReasoningType } = {
						slug: m.slug.trim(),
						label: m.label.trim(),
					};
					if (m.reasoning) entry.reasoning = m.reasoning;
					return entry;
				}),
			null,
			2,
		),
	);

	function addModel() {
		models.push({ slug: '', label: '', reasoning: undefined });
	}

	function removeModel(i: number) {
		models.splice(i, 1);
	}

	function moveUp(i: number) {
		if (i > 0) {
			const tmp = models[i - 1];
			models[i - 1] = models[i];
			models[i] = tmp;
		}
	}

	function moveDown(i: number) {
		if (i < models.length - 1) {
			const tmp = models[i + 1];
			models[i + 1] = models[i];
			models[i] = tmp;
		}
	}

	function resetToDefaults() {
		models = data.defaultModelList.map((m) => ({
			slug: m.slug,
			label: m.label,
			reasoning: m.reasoning as ReasoningType | undefined,
		}));
	}

	const deleteServer = (name: string) => confirmSubmit(`Delete MCP server "${name}"?`);
	const deleteSubAgentBy = (name: string) => confirmSubmit(`Delete sub-agent "${name}"?`);
</script>

<svelte:head>
	<title>Settings</title>
</svelte:head>

<div class="settings-layout d-flex flex-column gap-4 mx-auto w-100 p-3 overflow-auto">
	<h1 class="settings-title fs-3 fw-medium m-0">Settings</h1>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="appearance">
		<h2 id="appearance" class="fs-6 fw-semibold m-0 mb-2">Appearance</h2>
		<form {...themeForm.enhance(justSubmit)}>
			<input type="hidden" name="key" value="theme" />
			<label for="theme-select" class="form-label">Theme</label>
			<div class="d-flex gap-2">
				<select id="theme-select" name="value" class="form-select" style="width: auto" value={theme}>
					<option value="system">System</option>
					<option value="light">Light</option>
					<option value="dark">Dark</option>
				</select>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</section>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="cf-ai-gateway">
		<h2 id="cf-ai-gateway" class="fs-6 fw-semibold m-0 mb-2">Cloudflare AI Gateway</h2>
		<p class="text-muted small m-0 mb-2">
			When set, all third-party provider traffic (Anthropic, OpenAI, DeepSeek,
			and any catch-all model) is routed through your AI Gateway with
			Unified Billing / BYOK auth. Workers AI (<code>@cf/…</code>) is always
			routed via the binding and bills against Workers AI Neurons regardless.
			Set <code>CF_AI_GATEWAY_TOKEN</code> as a Worker secret to authenticate
			gateway requests.
		</p>
		<form {...cfAIGatewayIdForm.enhance(justSubmit)}>
			<input type="hidden" name="key" value="cf_ai_gateway_id" />
			<label for="cf-ai-gateway-input" class="form-label">Gateway slug</label>
			<div class="d-flex gap-2">
				<input
					id="cf-ai-gateway-input"
					type="text"
					name="value"
					value={data.cfAIGatewayId}
					placeholder="e.g. my-gateway"
					class="form-control"
					style="font-family: monospace; max-width: 24rem"
				/>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</section>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="secrets">
		<h2 id="secrets" class="fs-6 fw-semibold m-0 mb-2">Secrets</h2>
		<p class="text-muted small m-0 mb-2">
			API keys and sensitive values are stored as Worker secrets. Edit with
			<code>npx wrangler secret put NAME</code>.
		</p>
		<dl>
			{#each data.secretKeys as s (s.name)}
				<div class="d-grid" style="grid-template-columns: max-content 1fr; gap: 0.15rem 0.75rem">
					<dt><code>{s.name}</code></dt>
					<dd>
						<span class="badge {s.configured ? 'ok' : 'missing'}">
							{s.configured ? 'configured' : 'not configured'}
						</span>
					</dd>
				</div>
			{/each}
		</dl>
	</section>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="mcp-servers">
		<h2 id="mcp-servers" class="fs-6 fw-semibold m-0 mb-2">MCP servers</h2>
		<p class="text-muted small m-0 mb-2">
			HTTP and SSE MCP servers are queried for tools at the start of each
			generation. Stdio transport ships in a later phase.
		</p>
		{#if data.mcpServers.length === 0}
			<div class="empty">No MCP servers configured.</div>
		{:else}
			<ul class="list-unstyled d-flex flex-column gap-2 m-0 p-0">
				{#each data.mcpServers as s (s.id)}
					<li class="d-flex align-items-center justify-content-between gap-2 flex-wrap border rounded p-2">
						<div class="min-vw-0 flex-fill">
							<div class="fw-medium">
								{s.name}
								<span class="badge {s.enabled ? 'ok' : 'missing'}">
									{s.enabled ? 'enabled' : 'disabled'}
								</span>
							</div>
							<div class="text-muted small text-break">
								{s.transport.toUpperCase()} · {s.url ?? s.command ?? '—'}
							</div>
						</div>
						<form {...removeMcpServer.for(s.id).enhance(deleteServer(s.name))}>
							<input type="hidden" name="id" value={s.id} />
							<button type="submit" class="btn btn-sm btn-outline-secondary">Delete</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
		<details class="mt-3">
			<summary class="d-flex align-items-center" style="cursor: pointer; min-height: var(--tap-target)">
				Add server
			</summary>
			<form
				{...addMcpServer.enhance(justSubmit)}
				class="d-flex flex-column gap-2 mt-2"
			>
				<label class="form-label">
					Name
					<input type="text" name="name" required class="form-control" />
				</label>
				<label class="form-label">
					Transport
					<select name="transport" class="form-select">
						<option value="http">HTTP</option>
						<option value="sse">SSE</option>
					</select>
				</label>
				<label class="form-label">
					URL
					<input type="url" name="url" required class="form-control" />
				</label>
				<label class="form-label">
					Auth headers (JSON, optional)
					<input
						type="text"
						name="auth_json"
						placeholder={'{"Authorization":"Bearer …"}'}
						class="form-control"
					/>
				</label>
				<button type="submit" class="btn btn-primary">Save</button>
			</form>
		</details>
	</section>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="sub-agents">
		<h2 id="sub-agents" class="fs-6 fw-semibold m-0 mb-2">Sub-agents</h2>
		<p class="text-muted small m-0 mb-2">
			Specialised agents the main conversation can delegate to via the built-in
			<code>agent</code> tool. Each sub-agent runs its own LLM loop with a custom
			system prompt and a curated subset of tools, then returns a single text
			answer to the parent.
		</p>
		{#if data.subAgents.length === 0}
			<div class="empty">No sub-agents configured.</div>
		{:else}
			<ul class="list-unstyled d-flex flex-column gap-2 m-0 p-0">
				{#each data.subAgents as a (a.id)}
					<li class="d-flex flex-column gap-1 border rounded p-2">
						<div class="d-flex align-items-center gap-2 flex-wrap">
							<span class="fw-medium"><code>{a.name}</code></span>
							<span class="badge {a.enabled ? 'ok' : 'missing'}">
								{a.enabled ? 'enabled' : 'disabled'}
							</span>
							<span class="flex-fill"></span>
							<form {...toggleSubAgent.for(a.id).enhance(justSubmit)}>
								<input type="hidden" name="id" value={a.id} />
								<input type="hidden" name="enabled" value={a.enabled ? 'false' : 'true'} />
								<button type="submit" class="btn btn-sm btn-outline-secondary">{a.enabled ? 'Disable' : 'Enable'}</button>
							</form>
							<form {...removeSubAgent.for(a.id).enhance(deleteSubAgentBy(a.name))}>
								<input type="hidden" name="id" value={a.id} />
								<button type="submit" class="btn btn-sm btn-outline-secondary">Delete</button>
							</form>
						</div>
						<div class="text-muted small">{a.description}</div>
						<div class="text-muted small">
							{a.model ?? 'inherits parent model'}
							· iterations: {a.maxIterations ?? 'default'}
							· tools: {a.allowedTools ? a.allowedTools.join(', ') : 'all built-in'}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
		<details class="mt-3">
			<summary class="d-flex align-items-center" style="cursor: pointer; min-height: var(--tap-target)">
				Add sub-agent
			</summary>
			<form
				{...addSubAgent.enhance(justSubmit)}
				class="d-flex flex-column gap-2 mt-2"
			>
				<label class="form-label">
					Name
					<input
						type="text"
						name="name"
						required
						placeholder="researcher"
						pattern="[a-z][a-z0-9_-]{'0,63'}"
						class="form-control"
					/>
					<small class="text-muted d-block">
						Lowercase letters, digits, <code>_</code> and <code>-</code>. Must start with a letter.
					</small>
				</label>
				<label class="form-label">
					Description (when to invoke)
					<input
						type="text"
						name="description"
						required
						placeholder="Use to research a topic across multiple sources and produce a citation-backed summary."
						class="form-control"
					/>
				</label>
				<label class="form-label">
					System prompt
					<textarea
						name="system_prompt"
						rows="4"
						required
						placeholder="You are a research specialist. Gather facts from authoritative sources, cite each claim, and respond with a concise summary."
						class="form-control"
					></textarea>
				</label>
				<label class="form-label">
					Model (optional — leave blank to inherit the parent's model)
					<input
						type="text"
						name="model"
						placeholder="anthropic/claude-haiku-4.5"
						class="form-control"
					/>
				</label>
				<label class="form-label">
					Max iterations (optional — default 5)
					<input
						type="number"
						name="max_iterations"
						min="1"
						max="50"
						placeholder="5"
						class="form-control"
						style="width: 6rem"
					/>
				</label>
				<label class="form-label">
					Allowed tools (comma- or space-separated; leave blank for all built-in tools)
					<input
						type="text"
						name="allowed_tools"
						placeholder="web_search, fetch_url"
						class="form-control"
					/>
					<small class="text-muted d-block">
						Sub-agents can never call the <code>agent</code> tool itself.
					</small>
				</label>
				<button type="submit" class="btn btn-primary">Save</button>
			</form>
		</details>
	</section>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="system-prompt">
		<h2 id="system-prompt" class="fs-6 fw-semibold m-0 mb-2">System prompt</h2>
		<p class="text-muted small m-0 mb-2">
			Injected as a system message at the start of every chat. Leave blank to use the default.
		</p>
		<form {...systemPromptForm.enhance(justSubmit)}>
			<input type="hidden" name="key" value="system_prompt" />
			<textarea
				name="value"
				rows="5"
				value={data.systemPrompt}
				placeholder="You are Interface, an AI agent designed to serve as an interface between users and complex computer systems."
				class="form-control"
			></textarea>
			<button type="submit" class="btn btn-primary mt-2">Save</button>
		</form>
	</section>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="user-bio">
		<h2 id="user-bio" class="fs-6 fw-semibold m-0 mb-2">User bio</h2>
		<p class="text-muted small m-0 mb-2">
			Appended to the system message to give the AI context about you.
		</p>
		<form {...userBioForm.enhance(justSubmit)}>
			<input type="hidden" name="key" value="user_bio" />
			<textarea
				name="value"
				rows="4"
				value={data.userBio}
				placeholder="Tell the AI about yourself…"
				class="form-control"
			></textarea>
			<button type="submit" class="btn btn-primary mt-2">Save</button>
		</form>
	</section>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="model-list">
		<h2 id="model-list" class="fs-6 fw-semibold m-0 mb-2">Model list</h2>
		<p class="text-muted small m-0 mb-2">
			Models available in the composer dropdown.
		</p>
		<form {...modelListForm.enhance(justSubmit)}>
			<input type="hidden" name="key" value="model_list" />
			<input type="hidden" name="value" value={serializedModels} />
			{#if models.length > 0}
				<div class="d-flex flex-column gap-1">
					<div class="model-grid-header">
						<span class="small text-muted">Slug</span>
						<span class="small text-muted">Label</span>
						<span class="small text-muted">Reasoning</span>
						<span></span><span></span><span></span>
					</div>
					{#each models as model, i (i)}
						<div class="model-grid-row">
							<input
								type="text"
								placeholder="provider/model-slug"
								bind:value={model.slug}
								aria-label="Model slug"
								class="form-control form-control-sm"
								style="font-family: monospace"
							/>
							<input
								type="text"
								placeholder="Display name"
								bind:value={model.label}
								aria-label="Model label"
								class="form-control form-control-sm"
							/>
							<select bind:value={model.reasoning} aria-label="Reasoning type" class="form-select form-select-sm">
								<option value={undefined}>Auto</option>
								<option value="max_tokens">max_tokens</option>
								<option value="effort">effort</option>
							</select>
							<button
								type="button"
								onclick={() => moveUp(i)}
								disabled={i === 0}
								title="Move up"
								aria-label="Move up"
								class="btn btn-sm btn-outline-secondary"
							>↑</button>
							<button
								type="button"
								onclick={() => moveDown(i)}
								disabled={i === models.length - 1}
								title="Move down"
								aria-label="Move down"
								class="btn btn-sm btn-outline-secondary"
							>↓</button>
							<button
								type="button"
								onclick={() => removeModel(i)}
								title="Remove model"
								aria-label="Remove model"
								class="btn btn-sm btn-outline-secondary"
							>×</button>
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-muted fst-italic m-0 mt-1 mb-2">No models — saving will restore defaults.</p>
			{/if}
			<div class="d-flex gap-2 mt-3 flex-wrap">
				<button type="button" class="btn btn-outline-secondary" onclick={addModel}>+ Add model</button>
				<button type="button" class="btn btn-outline-secondary ms-auto" onclick={resetToDefaults}>
					Restore defaults
				</button>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</section>

	<section class="settings-section border rounded p-3 bg-body" aria-labelledby="context-compaction">
		<h2 id="context-compaction" class="fs-6 fw-semibold m-0 mb-2">Context compaction</h2>
		<p class="text-muted small m-0 mb-2">
			When estimated token usage exceeds this percentage of the model's context
			window, older messages are summarized to make room. 0 = disabled.
		</p>
		<form {...thresholdForm.enhance(justSubmit)}>
			<input type="hidden" name="key" value="context_compaction_threshold" />
			<div class="d-flex gap-2 align-items-center">
				<label for="threshold-input" class="form-label m-0">Threshold</label>
				<input
					id="threshold-input"
					type="number"
					name="value"
					min="0"
					max="100"
					step="1"
					value={data.contextCompactionThreshold}
					class="form-control"
					style="width: 5rem"
				/>
				<span class="text-muted">%</span>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
		<form {...summaryTokensForm.enhance(justSubmit)} class="mt-3">
			<input type="hidden" name="key" value="context_compaction_summary_tokens" />
			<div class="d-flex gap-2 align-items-center">
				<label for="summary-tokens-input" class="form-label m-0">Summary budget</label>
				<input
					id="summary-tokens-input"
					type="number"
					name="value"
					min="256"
					step="256"
					value={data.contextCompactionSummaryTokens}
					class="form-control"
					style="width: 6rem"
				/>
				<span class="text-muted">tokens</span>
				<button type="submit" class="btn btn-primary">Save</button>
			</div>
		</form>
	</section>
</div>

<style>
	.settings-layout {
		max-width: 760px;
		min-height: 0;
		flex: 1;
	}

	.settings-title {
		font-size: 1.5rem;
	}

	.badge {
		display: inline-block;
		padding: 0.15rem 0.55rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.badge.ok {
		background: rgba(82, 142, 96, 0.18);
		color: #3f7a4f;
	}

	.badge.missing {
		background: rgba(192, 96, 96, 0.18);
		color: #b85959;
	}

	@media (prefers-color-scheme: dark) {
		:global(html[data-theme='system']) .badge.ok {
			color: #80c69a;
		}
		:global(html[data-theme='system']) .badge.missing {
			color: #ec9292;
		}
	}

	:global(html[data-theme='dark']) .badge.ok {
		color: #80c69a;
	}

	:global(html[data-theme='dark']) .badge.missing {
		color: #ec9292;
	}

	.model-grid-header,
	.model-grid-row {
		display: grid;
		grid-template-columns: 1fr 1fr auto auto auto auto;
		gap: 0.4rem;
		align-items: center;
	}

	@media (max-width: 768px) {
		.settings-layout {
			padding-top: calc(0.5rem + 40px + 0.5rem);
		}
	}
</style>
