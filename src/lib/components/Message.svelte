<script lang="ts" module>
	import { buildResultsMap, groupParts } from './parts';
	export { buildResultsMap, groupParts };
</script>

<script lang="ts">
	import type { MessagePart, MessageRow } from '$lib/types/conversation';
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
