<script lang="ts">
	import type { PageData } from './$types';
	import { saveSetting, addMcpServer, removeMcpServer } from '$lib/settings.remote';
	import { page } from '$app/state';
	import { untrack } from 'svelte';

	let { data }: { data: PageData } = $props();
	const theme = $derived(page.data.theme as 'system' | 'light' | 'dark');

	const themeForm = saveSetting.for('theme');
	const systemPromptForm = saveSetting.for('system_prompt');
	const userBioForm = saveSetting.for('user_bio');
	const modelListForm = saveSetting.for('model_list');
	const thresholdForm = saveSetting.for('context_compaction_threshold');
	const summaryTokensForm = saveSetting.for('context_compaction_summary_tokens');

	let models = $state(untrack(() => data.modelList.map((m) => ({ ...m }))));

	const serializedModels = $derived(
		models
			.filter((m) => m.slug.trim())
			.map((m) => `${m.slug.trim()}|${m.label.trim()}`)
			.join('\n'),
	);

	function addModel() {
		models.push({ slug: '', label: '' });
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
		models = data.defaultModelList.map((m) => ({ ...m }));
	}

	function deleteHandler(name: string) {
		return async ({ submit }: { submit: () => Promise<unknown> }) => {
			if (!confirm(`Delete MCP server "${name}"?`)) return;
			await submit();
		};
	}
</script>

<svelte:head>
	<title>Settings</title>
</svelte:head>

<div class="settings-layout">
	<h1 class="settings-title">Settings</h1>

	<section class="settings-section" aria-labelledby="appearance">
		<h2 id="appearance">Appearance</h2>
		<form {...themeForm.enhance(async ({ submit }) => { await submit(); })}>
			<input type="hidden" name="key" value="theme" />
			<label for="theme-select" style="display: block; margin-bottom: 0.5rem">Theme</label>
			<div class="row" style="display: flex; gap: 0.5rem">
				<select id="theme-select" name="value" value={theme}>
					<option value="system">System</option>
					<option value="light">Light</option>
					<option value="dark">Dark</option>
				</select>
				<button type="submit">Save</button>
			</div>
		</form>
	</section>

	<section class="settings-section" aria-labelledby="provider-keys">
		<h2 id="provider-keys">Provider keys</h2>
		<p style="color: var(--muted); margin-top: 0">
			Provider API keys are stored as Worker secrets. Edit with
			<code>npx wrangler secret put NAME</code>.
		</p>
		<dl>
			{#each data.providerKeys as s (s.name)}
				<div style="display: contents">
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

	<section class="settings-section" aria-labelledby="mcp-servers">
		<h2 id="mcp-servers">MCP servers</h2>
		<p style="color: var(--muted); margin-top: 0">
			HTTP and SSE MCP servers are queried for tools at the start of each
			generation. Stdio transport ships in a later phase.
		</p>
		{#if data.mcpServers.length === 0}
			<div class="empty">No MCP servers configured.</div>
		{:else}
			<ul style="list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.5rem">
				{#each data.mcpServers as s (s.id)}
					<li
						style="border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap"
					>
						<div style="min-width: 0; flex: 1">
							<div style="font-weight: 500">
								{s.name}
								<span class="badge {s.enabled ? 'ok' : 'missing'}">
									{s.enabled ? 'enabled' : 'disabled'}
								</span>
							</div>
							<div style="color: var(--muted); font-size: 0.85em; word-break: break-all">
								{s.transport.toUpperCase()} · {s.url ?? s.command ?? '—'}
							</div>
						</div>
						<form {...removeMcpServer.for(s.id).enhance(deleteHandler(s.name))}>
							<input type="hidden" name="id" value={s.id} />
							<button type="submit">Delete</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
		<details style="margin-top: 0.75rem">
			<summary style="cursor: pointer; min-height: var(--tap-target); display: flex; align-items: center">
				Add server
			</summary>
			<form
				{...addMcpServer.enhance(async ({ submit }) => { await submit(); })}
				style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem"
			>
				<label>
					Name
					<input type="text" name="name" required style="display: block; width: 100%" />
				</label>
				<label>
					Transport
					<select name="transport" value="http" style="display: block; width: 100%">
						<option value="http">HTTP</option>
						<option value="sse">SSE</option>
					</select>
				</label>
				<label>
					URL
					<input type="url" name="url" required style="display: block; width: 100%" />
				</label>
				<label>
					Auth headers (JSON, optional)
					<input
						type="text"
						name="auth_json"
						placeholder={'{"Authorization":"Bearer …"}'}
						style="display: block; width: 100%"
					/>
				</label>
				<button type="submit">Save</button>
			</form>
		</details>
	</section>

	<section class="settings-section" aria-labelledby="system-prompt">
		<h2 id="system-prompt">System prompt</h2>
		<p style="color: var(--muted); margin-top: 0">
			Injected as a system message at the start of every chat. Leave blank to use the default.
		</p>
		<form {...systemPromptForm.enhance(async ({ submit }) => { await submit(); })}>
			<input type="hidden" name="key" value="system_prompt" />
			<textarea
				name="value"
				rows="5"
				value={data.systemPrompt}
				placeholder="You are Interface, an AI agent designed to serve as an interface between users and complex computer systems."
				style="display: block; width: 100%"
			></textarea>
			<button type="submit" style="margin-top: 0.5rem">Save</button>
		</form>
	</section>

	<section class="settings-section" aria-labelledby="user-bio">
		<h2 id="user-bio">User bio</h2>
		<p style="color: var(--muted); margin-top: 0">
			Appended to the system message to give the AI context about you.
		</p>
		<form {...userBioForm.enhance(async ({ submit }) => { await submit(); })}>
			<input type="hidden" name="key" value="user_bio" />
			<textarea
				name="value"
				rows="4"
				value={data.userBio}
				placeholder="Tell the AI about yourself…"
				style="display: block; width: 100%"
			></textarea>
			<button type="submit" style="margin-top: 0.5rem">Save</button>
		</form>
	</section>

	<section class="settings-section" aria-labelledby="model-list">
		<h2 id="model-list">Model list</h2>
		<p style="color: var(--muted); margin-top: 0">
			Models available in the composer dropdown.
		</p>
		<form {...modelListForm.enhance(async ({ submit }) => { await submit(); })}>
			<input type="hidden" name="key" value="model_list" />
			<input type="hidden" name="value" value={serializedModels} />
			{#if models.length > 0}
				<div style="display: flex; flex-direction: column; gap: 0.4rem">
					<div
						style="display: grid; grid-template-columns: 1fr 1fr auto auto auto; gap: 0.4rem; align-items: center; padding: 0 0.1rem"
					>
						<span style="font-size: 0.8rem; color: var(--muted)">Slug</span>
						<span style="font-size: 0.8rem; color: var(--muted)">Label</span>
						<span></span><span></span><span></span>
					</div>
					{#each models as model, i (i)}
						<div
							style="display: grid; grid-template-columns: 1fr 1fr auto auto auto; gap: 0.4rem; align-items: center"
						>
							<input
								type="text"
								placeholder="provider/model-slug"
								bind:value={model.slug}
								aria-label="Model slug"
								style="min-width: 0; font-family: monospace; font-size: 0.85rem"
							/>
							<input
								type="text"
								placeholder="Display name"
								bind:value={model.label}
								aria-label="Model label"
								style="min-width: 0"
							/>
							<button
								type="button"
								onclick={() => moveUp(i)}
								disabled={i === 0}
								title="Move up"
								aria-label="Move up">↑</button
							>
							<button
								type="button"
								onclick={() => moveDown(i)}
								disabled={i === models.length - 1}
								title="Move down"
								aria-label="Move down">↓</button
							>
							<button
								type="button"
								onclick={() => removeModel(i)}
								title="Remove model"
								aria-label="Remove model">×</button
							>
						</div>
					{/each}
				</div>
			{:else}
				<p style="color: var(--muted); font-style: italic; margin: 0.25rem 0 0.5rem">
					No models — saving will restore defaults.
				</p>
			{/if}
			<div style="display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap">
				<button type="button" onclick={addModel}>+ Add model</button>
				<button type="button" onclick={resetToDefaults} style="margin-left: auto">
					Restore defaults
				</button>
				<button type="submit">Save</button>
			</div>
		</form>
	</section>

	<section class="settings-section" aria-labelledby="context-compaction">
		<h2 id="context-compaction">Context compaction</h2>
		<p style="color: var(--muted); margin-top: 0">
			When estimated token usage exceeds this percentage of the model's context
			window, older messages are summarized to make room. 0 = disabled.
		</p>
		<form {...thresholdForm.enhance(async ({ submit }) => { await submit(); })}>
			<input type="hidden" name="key" value="context_compaction_threshold" />
			<div class="row" style="display: flex; gap: 0.5rem; align-items: center">
				<label for="threshold-input">Threshold</label>
				<input
					id="threshold-input"
					type="number"
					name="value"
					min="0"
					max="100"
					step="1"
					value={data.contextCompactionThreshold}
					style="width: 5rem"
				/>
				<span style="color: var(--muted)">%</span>
				<button type="submit">Save</button>
			</div>
		</form>
		<form {...summaryTokensForm.enhance(async ({ submit }) => { await submit(); })} style="margin-top: 0.75rem">
			<input type="hidden" name="key" value="context_compaction_summary_tokens" />
			<div class="row" style="display: flex; gap: 0.5rem; align-items: center">
				<label for="summary-tokens-input">Summary budget</label>
				<input
					id="summary-tokens-input"
					type="number"
					name="value"
					min="256"
					step="256"
					value={data.contextCompactionSummaryTokens}
					style="width: 6rem"
				/>
				<span style="color: var(--muted)">tokens</span>
				<button type="submit">Save</button>
			</div>
		</form>
	</section>
</div>
