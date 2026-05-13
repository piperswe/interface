<script lang="ts">
	import { ArrowLeft } from 'lucide-svelte';
	import MonacoEditor from '$lib/components/MonacoEditor.svelte';
	import { removeCustomTool, saveCustomTool, toggleCustomTool } from '$lib/custom-tools.remote';
	import { confirmToastSubmit, toastSubmit } from '$lib/form-actions';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const tool = $derived(data.tool);

	let name = $state('');
	let description = $state('');
	let source = $state('');
	let inputSchema = $state('');
	let secretsList = $state<{ key: string; value: string }[]>([]);

	$effect(() => {
		// Re-sync local state when the loader re-runs after a save redirect.
		void tool.id;
		void tool.updatedAt;
		name = tool.name;
		description = tool.description;
		source = tool.source;
		inputSchema = tool.inputSchema;
		secretsList = parseSecrets(tool.secretsJson);
	});

	function parseSecrets(json: string | null): { key: string; value: string }[] {
		if (!json) return [];
		try {
			const parsed = JSON.parse(json);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
			return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
				key,
				value: typeof value === 'string' ? value : JSON.stringify(value),
			}));
		} catch {
			return [];
		}
	}

	function secretsToJson(): string {
		const obj: Record<string, string> = {};
		for (const { key, value } of secretsList) {
			const k = key.trim();
			if (!k) continue;
			obj[k] = value;
		}
		return Object.keys(obj).length === 0 ? '' : JSON.stringify(obj);
	}

	function addSecret() {
		secretsList = [...secretsList, { key: '', value: '' }];
	}
	function removeSecret(idx: number) {
		secretsList = secretsList.filter((_, i) => i !== idx);
	}
</script>

<svelte:head>
	<title>{tool.name} · Tools · Settings</title>
</svelte:head>

<div class="settings-toolbar">
	<div class="d-flex flex-column">
		<a href="/settings#tools" class="small text-muted text-decoration-none d-inline-flex align-items-center gap-1"><ArrowLeft size={12} aria-hidden="true" /> Back to settings</a>
		<h2 class="h5 mb-1 mt-1">Edit tool · <code>{tool.name}</code></h2>
		<p class="small text-muted mb-0">
			Available to the agent as
			<code>custom_{tool.id}_{tool.name}</code>
			when enabled.
		</p>
	</div>
	<div class="d-flex gap-2">
		<form
			{...toggleCustomTool
				.for(`edit-${tool.id}`)
				.enhance(toastSubmit(tool.enabled ? 'Tool disabled' : 'Tool enabled'))}
			class="m-0"
		>
			<input type="hidden" name="id" value={tool.id} />
			<input type="hidden" name="enabled" value={tool.enabled ? 'false' : 'true'} />
			<button type="submit" class="btn btn-sm btn-outline-secondary">
				{tool.enabled ? 'Disable' : 'Enable'}
			</button>
		</form>
		<form
			{...removeCustomTool
				.for(`edit-${tool.id}`)
				.enhance(confirmToastSubmit(`Delete tool "${tool.name}"?`, 'Tool deleted'))}
			class="m-0"
		>
			<input type="hidden" name="id" value={tool.id} />
			<button type="submit" class="btn btn-sm btn-outline-danger">Delete</button>
		</form>
	</div>
</div>

<form
	{...saveCustomTool.for(`edit-${tool.id}`).enhance(toastSubmit('Tool saved'))}
	class="d-flex flex-column gap-3 mt-3"
>
	<input type="hidden" name="id" value={tool.id} />

	<section class="settings-card">
		<div class="settings-card-head">
			<h2 class="h6 mb-0">Metadata</h2>
			<p class="small text-muted mb-0">Name and description shown to the LLM.</p>
		</div>
		<div class="row g-2">
			<div class="col-md-4">
				<label class="form-label small d-block">
					<span class="d-block mb-1">Name</span>
					<input name="name" bind:value={name} class="form-control form-control-sm" required />
				</label>
			</div>
			<div class="col-md-8">
				<label class="form-label small d-block">
					<span class="d-block mb-1">Description</span>
					<input
						name="description"
						bind:value={description}
						class="form-control form-control-sm"
						required
					/>
				</label>
			</div>
		</div>
	</section>

	<section class="settings-card">
		<div class="settings-card-head">
			<h2 class="h6 mb-0">Source</h2>
			<p class="small text-muted mb-0">
				Full ES module — must <code>export default</code> a
				<code>WorkerEntrypoint</code> subclass with an async
				<code>run(input)</code> method.
				<code>this.env</code> contains the secrets you set below.
			</p>
		</div>
		<MonacoEditor bind:value={source} language="javascript" height="420px" />
		<input type="hidden" name="source" value={source} />
	</section>

	<section class="settings-card">
		<div class="settings-card-head">
			<h2 class="h6 mb-0">Input schema</h2>
			<p class="small text-muted mb-0">
				JSON Schema for the <code>input</code> argument the LLM passes.
			</p>
		</div>
		<textarea
			name="input_schema"
			bind:value={inputSchema}
			rows="8"
			class="form-control form-control-sm font-monospace"
			spellcheck="false"
			required
		></textarea>
	</section>

	<section class="settings-card">
		<div class="settings-card-head">
			<h2 class="h6 mb-0">Secrets</h2>
			<p class="small text-muted mb-0">
				Passed to the loaded worker as <code>this.env</code>. Stored in plaintext in D1.
			</p>
		</div>
		{#if secretsList.length > 0}
			<div class="d-flex flex-column gap-2 mb-2">
				{#each secretsList as _, idx (idx)}
					<div class="d-flex gap-2 align-items-center">
						<input
							class="form-control form-control-sm"
							placeholder="KEY"
							bind:value={secretsList[idx].key}
						/>
						<input
							class="form-control form-control-sm"
							placeholder="value"
							type="password"
							bind:value={secretsList[idx].value}
						/>
						<button
							type="button"
							class="btn btn-sm btn-link text-danger p-0"
							onclick={() => removeSecret(idx)}
						>
							Remove
						</button>
					</div>
				{/each}
			</div>
		{/if}
		<button type="button" class="btn btn-sm btn-outline-secondary" onclick={addSecret}>
			Add secret
		</button>
		<input type="hidden" name="secrets_json" value={secretsToJson()} />
	</section>

	<div class="d-flex justify-content-end">
		<button type="submit" class="btn btn-primary">Save tool</button>
	</div>
</form>
