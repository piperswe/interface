<script lang="ts" module>
	import { buildResultsMap, groupParts } from './parts';
	export { buildResultsMap, groupParts };
</script>

<script lang="ts">
	import type { MessageRow } from '$lib/types/conversation';
	import Artifact from './Artifact.svelte';
	import MetaPanel from './MetaPanel.svelte';
	import MessagePart from './MessagePart.svelte';
	import WorkBundle from './WorkBundle.svelte';

	let {
		message,
		timestamp,
		onSelectArtifact,
		modelPricing = null,
		kagiCostPer1000Searches = 25,
	}: {
		message: MessageRow;
		timestamp?: number;
		onSelectArtifact?: (id: string) => void;
		modelPricing?: {
			inputCostPerMillionTokens: number | null;
			outputCostPerMillionTokens: number | null;
		} | null;
		kagiCostPer1000Searches?: number;
	} = $props();

	const isAssistant = $derived(message.role === 'assistant');
	const isStreaming = $derived(message.status === 'streaming');
	const artifacts = $derived(message.artifacts ?? []);
	const parts = $derived(message.parts ?? []);
	const hasParts = $derived(isAssistant && parts.length > 0);
	const showHtml = $derived(typeof message.contentHtml === 'string' && message.contentHtml.length > 0);

	const results = $derived(buildResultsMap(parts));
	const groups = $derived(groupParts(parts, isStreaming, results));
	const lastIndex = $derived(parts.length - 1);
</script>

{#if timestamp !== undefined && message.role === 'user'}
	<time class="message-timestamp" datetime={new Date(timestamp).toISOString()}>
		{new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
	</time>
{/if}
<div id={`m-${message.id}`} class="message d-flex flex-column gap-1" data-message-id={message.id} data-role={message.role} data-status={message.status}>
	<div class="role">
		{message.role}{message.model ? ` · ${message.model}` : ''}
		{#if isStreaming}<span class="streaming-indicator" aria-label="streaming">●</span>{/if}
	</div>

	{#if hasParts}
		{#each groups as group (group.kind === 'bundle' ? group.key : `s-${group.index}`)}
			{#if group.kind === 'standalone'}
				<MessagePart
					part={group.part}
					index={group.index}
					{lastIndex}
					{isStreaming}
					{results}
					nested={false}
				/>
			{:else}
				<WorkBundle {group} {isStreaming} {results} {lastIndex} />
			{/if}
		{/each}
	{:else if showHtml}
		<div class="content text-break">{@html message.contentHtml}</div>
	{:else}
		<div class="content text-break" style="white-space: pre-wrap">{message.content}</div>
	{/if}

	{#if artifacts.length > 0}
			<div class="artifacts d-flex flex-column gap-2 mt-2">
				{#each artifacts as a (a.id)}
					<Artifact artifact={a} onSelect={onSelectArtifact} />
				{/each}
			</div>
	{/if}

	{#if message.status === 'error' && message.error}
		<div class="error small rounded p-2 border">{message.error}</div>
	{/if}
	{#if isStreaming}
		<div class="message-spinner d-flex align-items-center gap-2 small text-muted" aria-label="Generating response…"><span class="spinner"></span></div>
	{/if}
	{#if isAssistant && !isStreaming}
		<MetaPanel
			snapshot={message.meta}
			{modelPricing}
			parts={message.parts ?? null}
			{kagiCostPer1000Searches}
		/>
	{/if}
</div>

<style>
	.message[data-role='user'] {
		align-items: flex-end;
	}

	.message[data-role='user'] .role,
	.message[data-role='assistant'] .role {
		display: none;
	}

	/* `.content` is rendered both here (no-parts fallback) and inside
	 * `MessagePart.svelte` (text parts). Mark these styles `:global()` so
	 * the same look applies in both places without duplication. */
	.message[data-role='user'] :global(> .content),
	.message[data-role='user'] :global(> .content + .content) {
		background: var(--user-bg);
		border-radius: 18px 18px 4px 18px;
		padding: 0.6rem 0.95rem;
		max-width: 85%;
		color: var(--fg);
	}

	.message[data-role='assistant'] :global(> .content),
	.message[data-role='assistant'] :global(> details),
	.message[data-role='assistant'] :global(> .tool-call),
	.message[data-role='assistant'] :global(> .artifacts) {
		width: 100%;
	}

	:global(.content) {
		word-break: break-word;
		overflow-wrap: anywhere;
	}

	:global(.content > *:first-child) {
		margin-top: 0;
	}

	:global(.content > *:last-child) {
		margin-bottom: 0;
	}

	.message[data-status='error'] {
		color: var(--error-fg);
	}

	.error {
		color: var(--error-fg);
		background: var(--error-bg);
		border-color: var(--error-border);
	}

	/* Streaming indicator is reused inside ThinkingPart and WorkBundle
	 * summaries; declared global so child components don't have to
	 * redeclare the keyframes. */
	:global(.streaming-indicator) {
		display: inline-block;
		margin-left: 0.4rem;
		color: var(--accent);
		font-size: 0.7em;
		line-height: 1;
		animation: streaming-pulse 1.1s ease-in-out infinite;
	}

	@keyframes streaming-pulse {
		0%, 100% { opacity: 0.35; }
		50% { opacity: 1; }
	}

	.message-spinner {
		margin-top: 0.25rem;
		font-style: italic;
	}

	.spinner {
		display: inline-block;
		width: 1.1rem;
		height: 1.1rem;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* Markdown content overrides — applied via `:global(.content ...)` so
	 * they reach into `{@html}` rendered output and into the `.content`
	 * divs declared inside child components (MessagePart). */
	:global(.content p) {
		margin: 0.55em 0;
	}

	:global(.content h1),
	:global(.content h2),
	:global(.content h3),
	:global(.content h4),
	:global(.content h5),
	:global(.content h6) {
		margin: 1em 0 0.5em;
		font-weight: 600;
		line-height: 1.3;
	}

	:global(.content code) {
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 0.875em;
		background: var(--code-bg);
		padding: 0.1em 0.35em;
		border-radius: 4px;
	}

	:global(.content pre),
	:global(.content pre.shiki) {
		background: var(--code-block-bg);
		color: var(--code-block-fg);
		padding: 0.85rem 1rem;
		border-radius: var(--bs-border-radius-lg);
		overflow-x: auto;
		font-size: 0.85em;
		margin: 0.75em 0;
		-webkit-overflow-scrolling: touch;
	}

	:global(.content pre code) {
		background: none;
		padding: 0;
		color: inherit;
	}

	:global(.content blockquote) {
		border-left: 3px solid var(--accent);
		margin: 0.75em 0;
		padding: 0.1em 1em;
		color: var(--muted);
	}

	:global(.content ul),
	:global(.content ol) {
		margin: 0.5em 0;
		padding-left: 1.5em;
	}

	:global(.content li) {
		margin: 0.2em 0;
	}

	:global(.content table) {
		border-collapse: collapse;
		margin: 0.75em 0;
		display: block;
		overflow-x: auto;
		max-width: 100%;
	}

	:global(.content th),
	:global(.content td) {
		border: 1px solid var(--border);
		padding: 0.4em 0.7em;
	}

	:global(.content th) {
		background: var(--bs-secondary-bg);
		font-weight: 600;
	}

	:global(.content a) {
		color: var(--accent);
	}

	/* Inline citation markers — `[N]` rendered by the marked-inline-citation
	 * extension. Small superscript pill that links to the matching entry in
	 * the Sources block. */
	:global(.content .citation-ref) {
		font-size: 0.7em;
		line-height: 0;
		margin-left: 0.1em;
		vertical-align: super;
	}

	:global(.content .citation-ref a) {
		text-decoration: none;
		padding: 0.05em 0.35em;
		border-radius: 4px;
		background: var(--bs-secondary-bg, rgba(127, 127, 127, 0.15));
		color: var(--accent);
	}

	:global(.content .citation-ref a:hover) {
		text-decoration: underline;
	}

	:global(.content hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1.25em 0;
	}

	:global(.content .katex-display) {
		overflow-x: auto;
		overflow-y: hidden;
		padding: 0.25rem 0;
	}

	.message-timestamp {
		display: block;
		text-align: right;
		font-size: 0.75rem;
		color: var(--muted-2);
		margin-bottom: -0.5rem;
	}
</style>
