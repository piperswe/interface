<script lang="ts">
	import type { MessagePart, ToolResultPart } from '$lib/types/conversation';
	import ThinkingPart from './ThinkingPart.svelte';
	import InfoPart from './InfoPart.svelte';
	import CitationsPart from './CitationsPart.svelte';
	import ToolCall from './ToolCall.svelte';

	let {
		part,
		index,
		lastIndex,
		isStreaming,
		results,
		nested,
	}: {
		part: MessagePart;
		index: number;
		lastIndex: number;
		isStreaming: boolean;
		results: Map<string, ToolResultPart>;
		nested: boolean;
	} = $props();

	// A trailing thinking part on a streaming message is "current" — open by
	// default and shows the streaming indicator.
	const isCurrentThinking = $derived(
		isStreaming && index === lastIndex && part.type === 'thinking',
	);
</script>

{#if part.type === 'text'}
	{#if part.text}
		{#if part.textHtml}
			<div class="content text-break">{@html part.textHtml}</div>
		{:else}
			<div class="content text-break" style="white-space: pre-wrap">{part.text}</div>
		{/if}
	{/if}
{:else if part.type === 'thinking'}
	<ThinkingPart {part} isCurrent={isCurrentThinking} {nested} />
{:else if part.type === 'info'}
	<InfoPart {part} />
{:else if part.type === 'citations'}
	<CitationsPart {part} />
{:else if part.type === 'tool_use'}
	{@const result = results.get(part.id)}
	<ToolCall
		call={{ id: part.id, name: part.name, input: part.input, inputHtml: part.inputHtml, startedAt: part.startedAt }}
		result={result ? { toolUseId: result.toolUseId, content: result.content, isError: result.isError, streaming: result.streaming, startedAt: result.startedAt, endedAt: result.endedAt } : undefined}
		defaultOpen={isStreaming && !result}
		{nested}
	/>
{/if}
