<script lang="ts" module>
	import type { MessagePart, ToolResultPart } from '$lib/types/conversation';

	type Bundle = { kind: 'bundle'; key: string; parts: { part: MessagePart; index: number }[]; hasActive: boolean; mixed: boolean };
	type Standalone = { kind: 'standalone'; part: MessagePart; index: number };
	type Group = Bundle | Standalone;

	const isOutput = (part: MessagePart) => part.type === 'text' || part.type === 'info';

	export function buildResultsMap(parts: MessagePart[]): Map<string, ToolResultPart> {
		const m = new Map<string, ToolResultPart>();
		for (const p of parts) if (p.type === 'tool_result') m.set(p.toolUseId, p);
		return m;
	}

	// Group consecutive non-output parts (thinking, tool_use, tool_result)
	// into a single collapsible bundle. Text/info stay standalone. Mirrors
	// the React `renderParts` logic from the previous implementation.
	export function groupParts(parts: MessagePart[], streaming: boolean, results: Map<string, ToolResultPart>): Group[] {
		const groups: Group[] = [];
		let bundle: { part: MessagePart; index: number }[] = [];

		const flush = () => {
			if (bundle.length === 0) return;
			if (bundle.length === 1) {
				groups.push({ kind: 'standalone', part: bundle[0].part, index: bundle[0].index });
			} else {
				const hasActive = bundle.some(({ part, index }) => {
					if (part.type === 'thinking') return streaming && index === parts.length - 1;
					if (part.type === 'tool_use') return streaming && !results.get(part.id);
					return false;
				});
				const mixed = bundle.some((b) => b.part.type === 'tool_use');
				groups.push({
					kind: 'bundle',
					key: `bundle-${bundle[0].index}-${bundle[bundle.length - 1].index}`,
					parts: bundle,
					hasActive,
					mixed,
				});
			}
			bundle = [];
		};

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (isOutput(part)) {
				flush();
				if (part.type === 'text' && !part.text) continue;
				groups.push({ kind: 'standalone', part, index: i });
			} else {
				bundle.push({ part, index: i });
			}
		}
		flush();
		return groups;
	}
</script>

<script lang="ts">
	import type { MessageRow } from '$lib/types/conversation';
	import Artifact from './Artifact.svelte';
	import MetaPanel from './MetaPanel.svelte';
	import ToolCall from './ToolCall.svelte';

	let { message }: { message: MessageRow } = $props();

	const isAssistant = $derived(message.role === 'assistant');
	const isStreaming = $derived(message.status === 'streaming');
	const artifacts = $derived(message.artifacts ?? []);
	const parts = $derived(message.parts ?? []);
	const hasParts = $derived(isAssistant && parts.length > 0);
	const showHtml = $derived(typeof message.contentHtml === 'string' && message.contentHtml.length > 0);

	const results = $derived(buildResultsMap(parts));
	const groups = $derived(groupParts(parts, isStreaming, results));

	function partIsCurrent(part: MessagePart, index: number): boolean {
		return isStreaming && index === parts.length - 1 && part.type === 'thinking';
	}
</script>

{#snippet renderPart(part: MessagePart, index: number, nested: boolean)}
	{#if part.type === 'text'}
		{#if part.text}
			{#if part.textHtml}
				<div class="content">{@html part.textHtml}</div>
			{:else}
				<div class="content" style="white-space: pre-wrap">{part.text}</div>
			{/if}
		{/if}
	{:else if part.type === 'thinking'}
		{#if part.text}
			<details class="thinking{nested ? ' nested' : ''}" open={partIsCurrent(part, index)}>
				<summary>
					<span class="thinking-label">Thinking</span>
					{#if partIsCurrent(part, index)}<span class="streaming-indicator" aria-hidden="true">●</span>{/if}
				</summary>
				{#if part.textHtml}
					<div class="thinking-body">{@html part.textHtml}</div>
				{:else}
					<div class="thinking-body" style="white-space: pre-wrap">{part.text}</div>
				{/if}
			</details>
		{/if}
	{:else if part.type === 'info'}
		<div class="info-part">
			<span class="info-part-icon">ℹ</span>
			{part.text}
		</div>
	{:else if part.type === 'tool_use'}
		{@const result = results.get(part.id)}
		<ToolCall
			call={{ id: part.id, name: part.name, input: part.input }}
			result={result ? { toolUseId: result.toolUseId, content: result.content, isError: result.isError } : undefined}
			defaultOpen={isStreaming && !result}
			{nested}
		/>
	{/if}
{/snippet}

<div class="message" data-message-id={message.id} data-role={message.role} data-status={message.status}>
	<div class="role">
		{message.role}{message.model ? ` · ${message.model}` : ''}
		{#if isStreaming}<span class="streaming-indicator" aria-label="streaming">●</span>{/if}
	</div>

	{#if hasParts}
		{#each groups as group (group.kind === 'bundle' ? group.key : `s-${group.index}`)}
			{#if group.kind === 'standalone'}
				{@render renderPart(group.part, group.index, false)}
			{:else}
				<details class="work-bundle" open={group.hasActive}>
					<summary>
						<span class="work-bundle-label">{group.mixed ? 'Tools & thinking' : 'Thinking'}</span>
						{#if group.hasActive}<span class="streaming-indicator" aria-hidden="true">●</span>{/if}
					</summary>
					<div class="work-bundle-body">
						{#each group.parts as item (item.index)}
							{@render renderPart(item.part, item.index, true)}
						{/each}
					</div>
				</details>
			{/if}
		{/each}
	{:else if showHtml}
		<div class="content">{@html message.contentHtml}</div>
	{:else}
		<div class="content" style="white-space: pre-wrap">{message.content}</div>
	{/if}

	{#if artifacts.length > 0}
		<div class="artifacts">
			{#each artifacts as a (a.id)}
				<Artifact artifact={a} />
			{/each}
		</div>
	{/if}

	{#if message.status === 'error' && message.error}
		<div class="error">{message.error}</div>
	{/if}
	{#if isStreaming}
		<div class="message-spinner" aria-label="Generating response…"><span class="spinner"></span></div>
	{/if}
	{#if isAssistant && !isStreaming}
		<MetaPanel snapshot={message.meta} />
	{/if}
</div>
