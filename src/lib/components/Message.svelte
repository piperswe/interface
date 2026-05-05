<script lang="ts" module>
	import { buildResultsMap, groupParts } from './parts';
	export { buildResultsMap, groupParts };
</script>

<script lang="ts">
	import type { MessagePart, MessageRow } from '$lib/types/conversation';
	import Artifact from './Artifact.svelte';
	import MetaPanel from './MetaPanel.svelte';
	import ToolCall from './ToolCall.svelte';

	let { message, timestamp, onSelectArtifact }: { message: MessageRow; timestamp?: number; onSelectArtifact?: (id: string) => void } = $props();

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
				<div class="content text-break">{@html part.textHtml}</div>
			{:else}
				<div class="content text-break" style="white-space: pre-wrap">{part.text}</div>
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
		<div class="info-part d-flex align-items-center gap-2 rounded p-2 border-start border-3">
			<span class="info-part-icon">ℹ</span>
			{part.text}
		</div>
	{:else if part.type === 'citations'}
		{#if part.citations.length > 0}
			<details class="citations-part rounded border" open>
				<summary class="citations-summary px-2 py-1 small">
					<span class="citations-label">Sources</span>
					<span class="citations-count text-muted">({part.citations.length})</span>
				</summary>
				<ol class="citations-list list-unstyled m-0 p-2 d-flex flex-column gap-2">
					{#each part.citations as c, i (`${i}-${c.url}`)}
						<li class="citation small">
							<a
								class="citation-link text-decoration-none"
								href={c.url}
								target="_blank"
								rel="noopener noreferrer"
							>{c.title || c.url}</a>
							<div class="citation-url text-muted text-truncate">{c.url}</div>
							{#if c.snippet}
								<div class="citation-snippet text-muted">{c.snippet}</div>
							{/if}
						</li>
					{/each}
				</ol>
			</details>
		{/if}
	{:else if part.type === 'tool_use'}
		{@const result = results.get(part.id)}
		<ToolCall
			call={{ id: part.id, name: part.name, input: part.input, inputHtml: part.inputHtml, startedAt: part.startedAt }}
			result={result ? { toolUseId: result.toolUseId, content: result.content, isError: result.isError, streaming: result.streaming, startedAt: result.startedAt, endedAt: result.endedAt } : undefined}
			defaultOpen={isStreaming && !result}
			{nested}
		/>
	{/if}
{/snippet}

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
				{@render renderPart(group.part, group.index, false)}
			{:else}
				<details class="work-bundle" open={group.isLast && isStreaming}>
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
		<MetaPanel snapshot={message.meta} />
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

	.message[data-role='user'] > .content,
	.message[data-role='user'] > .content + .content {
		background: var(--user-bg);
		border-radius: 18px 18px 4px 18px;
		padding: 0.6rem 0.95rem;
		max-width: 85%;
		color: var(--fg);
	}

	.message[data-role='assistant'] > .content,
	.message[data-role='assistant'] > :global(details),
	.message[data-role='assistant'] > :global(.tool-call),
	.message[data-role='assistant'] > :global(.artifacts) {
		width: 100%;
	}

	.content {
		word-break: break-word;
		overflow-wrap: anywhere;
	}

	.content > :global(*:first-child) {
		margin-top: 0;
	}

	.content > :global(*:last-child) {
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

	.streaming-indicator {
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

	/* Markdown content overrides */
	.content :global(p) {
		margin: 0.55em 0;
	}

	.content :global(h1),
	.content :global(h2),
	.content :global(h3),
	.content :global(h4),
	.content :global(h5),
	.content :global(h6) {
		margin: 1em 0 0.5em;
		font-weight: 600;
		line-height: 1.3;
	}

	.content :global(code) {
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 0.875em;
		background: var(--code-bg);
		padding: 0.1em 0.35em;
		border-radius: 4px;
	}

	.content :global(pre),
	.content :global(pre.shiki) {
		background: var(--code-block-bg);
		color: var(--code-block-fg);
		padding: 0.85rem 1rem;
		border-radius: var(--bs-border-radius-lg);
		overflow-x: auto;
		font-size: 0.85em;
		margin: 0.75em 0;
		-webkit-overflow-scrolling: touch;
	}

	.content :global(pre) :global(code) {
		background: none;
		padding: 0;
		color: inherit;
	}

	.content :global(blockquote) {
		border-left: 3px solid var(--accent);
		margin: 0.75em 0;
		padding: 0.1em 1em;
		color: var(--muted);
	}

	.content :global(ul),
	.content :global(ol) {
		margin: 0.5em 0;
		padding-left: 1.5em;
	}

	.content :global(li) {
		margin: 0.2em 0;
	}

	.content :global(table) {
		border-collapse: collapse;
		margin: 0.75em 0;
		display: block;
		overflow-x: auto;
		max-width: 100%;
	}

	.content :global(th),
	.content :global(td) {
		border: 1px solid var(--border);
		padding: 0.4em 0.7em;
	}

	.content :global(th) {
		background: var(--bs-secondary-bg);
		font-weight: 600;
	}

	.content :global(a) {
		color: var(--accent);
	}

	.content :global(hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1.25em 0;
	}

	.content :global(.katex-display) {
		overflow-x: auto;
		overflow-y: hidden;
		padding: 0.25rem 0;
	}

	/* Inline thinking parts */
	details.thinking {
		border-left: 2px solid var(--border-soft);
		padding: 0.1rem 0 0.1rem 0.75rem;
		color: var(--muted);
		font-size: 0.92em;
	}

	details.thinking summary {
		cursor: pointer;
		padding: 0.2rem 0;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--muted);
		list-style: none;
		font-style: italic;
	}

	details.thinking summary::-webkit-details-marker,
	details.thinking summary::marker {
		display: none;
		content: '';
	}

	details.thinking summary::before {
		content: '▸';
		font-size: 0.7em;
		color: var(--muted-2);
		transition: transform 100ms ease;
		display: inline-block;
	}

	details.thinking[open] summary::before {
		transform: rotate(90deg);
	}

	details.thinking .thinking-label {
		font-weight: 500;
	}

	details.thinking .thinking-body {
		padding: 0.3rem 0;
		color: var(--muted);
	}

	details.thinking .thinking-body :global(p:first-child) {
		margin-top: 0;
	}

	details.thinking .thinking-body :global(p:last-child) {
		margin-bottom: 0;
	}

	/* Info parts */
	.info-part {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--muted);
		font-size: 0.875rem;
		margin: 0.25rem 0;
	}

	.info-part-icon {
		font-size: 1rem;
		line-height: 1;
		flex-shrink: 0;
	}

	/* Citations parts */
	.citations-part {
		background: var(--bs-body-bg);
		border-color: var(--border-soft);
		font-size: 0.875rem;
		margin: 0.25rem 0;
	}

	.citations-summary {
		cursor: pointer;
		list-style: none;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--muted);
		user-select: none;
	}

	.citations-summary::-webkit-details-marker {
		display: none;
	}

	.citations-label {
		font-weight: 500;
	}

	.citation-link {
		color: var(--accent);
		font-weight: 500;
		word-break: break-word;
	}

	.citation-link:hover {
		text-decoration: underline;
	}

	.citation-url {
		font-size: 0.75rem;
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
	}

	.citation-snippet {
		font-size: 0.8rem;
		margin-top: 0.15rem;
	}

	/* Work bundles */
	.work-bundle {
		border: 1px solid var(--border-soft);
		border-radius: var(--bs-border-radius);
		background: var(--bs-body-bg);
		font-size: 0.88em;
		margin: 0.25rem 0;
	}

	.work-bundle summary {
		cursor: pointer;
		list-style: none;
		padding: 0.4rem 0.65rem;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--muted);
		user-select: none;
	}

	.work-bundle summary::-webkit-details-marker,
	.work-bundle summary::marker {
		display: none;
		content: '';
	}

	.work-bundle summary::before {
		content: '▸';
		font-size: 0.7em;
		color: var(--muted-2);
		transition: transform 100ms ease;
		display: inline-block;
	}

	.work-bundle[open] summary::before {
		transform: rotate(90deg);
	}

	.work-bundle summary:hover {
		color: var(--fg);
	}

	.work-bundle-label {
		font-weight: 500;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.work-bundle-body {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.3rem 0.5rem;
	}

	/* Nested adjustments */
	details.thinking.nested {
		padding-left: 0.35rem;
	}

	.message-timestamp {
		display: block;
		text-align: right;
		font-size: 0.75rem;
		color: var(--muted-2);
		margin-bottom: -0.5rem;
	}
</style>
