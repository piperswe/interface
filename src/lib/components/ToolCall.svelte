<script lang="ts">
	import type { ToolCallRecord, ToolResultRecord } from '$lib/types/conversation';

	let {
		call,
		result,
		defaultOpen = false,
		nested = false,
	}: {
		call: ToolCallRecord;
		result?: ToolResultRecord;
		defaultOpen?: boolean;
		nested?: boolean;
	} = $props();

	const pending = $derived(!result);
	const open = $derived(pending || defaultOpen);
	const isStreaming = $derived(!!result?.streaming);
	const isError = $derived(!!result?.isError);
	const isDone = $derived(!!result && !result.streaming);

	// Tool-specific input shapes
	const execInput = $derived(
		call.name === 'sandbox_exec'
			? (call.input as { command?: string; cwd?: string; env?: Record<string, string>; stdin?: string; timeout?: number })
			: null,
	);

	const runCodeInput = $derived(
		call.name === 'sandbox_run_code'
			? (call.input as { code?: string; language?: string; timeout?: number })
			: null,
	);

	const webSearchInput = $derived(
		call.name === 'web_search' ? (call.input as { query?: string; count?: number }) : null,
	);

	const FILE_OPS = ['sandbox_read_file', 'sandbox_write_file', 'sandbox_delete_file', 'sandbox_mkdir', 'sandbox_exists'];
	const fileOpInput = $derived(
		FILE_OPS.includes(call.name)
			? (call.input as { path?: string; content?: string; recursive?: boolean })
			: null,
	);

	// Parse the structured exec result (only valid when isDone)
	type ExecParsed = { exitCode: number | null; success: boolean | null; stdout: string; stderr: string };
	function parseExecResult(content: string): ExecParsed {
		let exitCode: number | null = null;
		let success: boolean | null = null;
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		let section: 'none' | 'stdout' | 'stderr' = 'none';
		for (const line of content.split('\n')) {
			if (line.startsWith('exitCode: ')) {
				exitCode = parseInt(line.slice(10), 10);
			} else if (line.startsWith('success: ')) {
				success = line.slice(9) === 'true';
			} else if (line === '--- stdout ---') {
				section = 'stdout';
			} else if (line === '--- stderr ---') {
				section = 'stderr';
			} else if (section === 'stdout') {
				stdoutLines.push(line);
			} else if (section === 'stderr') {
				stderrLines.push(line);
			}
		}
		return { exitCode, success, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
	}

	const execParsed = $derived(
		call.name === 'sandbox_exec' && result && isDone ? parseExecResult(result.content) : null,
	);

	// Parse web search results from formatted text
	type SearchResult = { index: number; title: string; url: string; snippet: string };
	function parseSearchResults(content: string): SearchResult[] {
		const results: SearchResult[] = [];
		// Each result block: `\n[N] Title\n  url\n  snippet`
		const blockRe = /\[(\d+)\] (.+?)\n {2}(\S+)\n {2}(.+?)(?=\n\n|\n\[|\s*$)/gs;
		let m: RegExpExecArray | null;
		while ((m = blockRe.exec(content)) !== null) {
			results.push({ index: parseInt(m[1], 10), title: m[2], url: m[3], snippet: m[4] });
		}
		return results;
	}

	const searchResults = $derived(
		call.name === 'web_search' && result && isDone ? parseSearchResults(result.content) : [],
	);

	// Summary headline: the key "what is this doing" per tool
	const headline = $derived(
		execInput?.command
			? execInput.command.length > 80
				? execInput.command.slice(0, 78) + '…'
				: execInput.command
			: runCodeInput?.code
				? (runCodeInput.language ?? 'python')
				: webSearchInput?.query
					? webSearchInput.query
					: fileOpInput?.path
						? fileOpInput.path
						: null,
	);

	const toolLabel = $derived(
		call.name === 'sandbox_exec'
			? 'exec'
			: call.name === 'sandbox_run_code'
				? 'code'
				: call.name === 'web_search'
					? 'search'
					: call.name === 'sandbox_read_file'
						? 'read'
						: call.name === 'sandbox_write_file'
							? 'write'
							: call.name === 'sandbox_delete_file'
								? 'delete'
								: call.name === 'sandbox_mkdir'
									? 'mkdir'
									: call.name === 'sandbox_exists'
										? 'exists'
										: call.name,
	);
</script>

<details class="tool-call{nested ? ' nested' : ''}" data-tool-name={call.name} {open}>
	<summary>
		<span class="chevron" aria-hidden="true">▸</span>
		<span class="tool-label">{toolLabel}</span>
		{#if headline}
			<span class="tool-headline"
				>{call.name === 'sandbox_exec' ? '$ ' : ''}{headline}</span
			>
		{/if}

		{#if pending}
			<span class="status running ms-auto">running<span class="dot" aria-hidden="true">●</span></span>
		{:else if isError}
			<span class="status error ms-auto">
				{#if execParsed?.exitCode != null}exit {execParsed.exitCode}{:else}error{/if}
			</span>
		{:else if isStreaming}
			<span class="status running ms-auto">streaming<span class="dot" aria-hidden="true">●</span></span>
		{:else}
			<span class="status done ms-auto">done</span>
		{/if}
	</summary>

	<div class="tool-body">
		<!-- ── sandbox_exec ── -->
		{#if call.name === 'sandbox_exec' && execInput}
			<div class="exec-meta">
				<div class="terminal-line">
					<span class="prompt">$</span>
					<span class="cmd">{execInput.command ?? ''}</span>
				</div>
				{#if execInput.cwd}
					<div class="meta-row"><span class="meta-key">cwd</span><span class="meta-val">{execInput.cwd}</span></div>
				{/if}
				{#if execInput.env && Object.keys(execInput.env).length > 0}
					<div class="meta-row">
						<span class="meta-key">env</span>
						<span class="meta-val">{Object.entries(execInput.env).map(([k, v]) => `${k}=${v}`).join(' ')}</span>
					</div>
				{/if}
				{#if execInput.timeout}
					<div class="meta-row"><span class="meta-key">timeout</span><span class="meta-val">{execInput.timeout}ms</span></div>
				{/if}
			</div>

			{#if result}
				{#if isStreaming}
					<!-- Live streaming output -->
					<div class="terminal-output streaming">
						<pre><code>{result.content || ' '}</code></pre>
					</div>
				{:else if execParsed}
					<!-- Structured final output -->
					{#if execParsed.exitCode != null}
						<div class="exit-badge{execParsed.success === false ? ' fail' : ' ok'}">
							exit {execParsed.exitCode}
						</div>
					{/if}
					{#if execParsed.stdout}
						<div class="output-section">
							<div class="output-label">stdout</div>
							<div class="terminal-output"><pre><code>{execParsed.stdout}</code></pre></div>
						</div>
					{/if}
					{#if execParsed.stderr}
						<div class="output-section">
							<div class="output-label stderr">stderr</div>
							<div class="terminal-output"><pre><code>{execParsed.stderr}</code></pre></div>
						</div>
					{/if}
					{#if !execParsed.stdout && !execParsed.stderr}
						<div class="empty-output">no output</div>
					{/if}
				{:else}
					<!-- Fallback for unexpected format -->
					<div class="terminal-output"><pre><code>{result.content}</code></pre></div>
				{/if}
			{:else}
				<div class="pending-output">waiting for output…</div>
			{/if}

		<!-- ── sandbox_run_code ── -->
		{:else if call.name === 'sandbox_run_code' && runCodeInput}
			<div class="code-section">
				<div class="output-label">{runCodeInput.language ?? 'python'}</div>
				<pre class="code-block"><code>{runCodeInput.code ?? ''}</code></pre>
			</div>
			{#if result}
				<div class="output-section">
					<div class="output-label">output</div>
					<div class="terminal-output{isError ? ' error' : ''}">
						<pre><code>{result.content || '(no output)'}</code></pre>
					</div>
				</div>
			{:else}
				<div class="pending-output">running…</div>
			{/if}

		<!-- ── web_search ── -->
		{:else if call.name === 'web_search' && webSearchInput}
			<div class="search-query">
				<span class="search-icon">⌕</span>
				<span>{webSearchInput.query ?? ''}</span>
				{#if webSearchInput.count}<span class="meta-note">· {webSearchInput.count} results</span>{/if}
			</div>

			{#if result}
				{#if isStreaming || pending}
					<div class="pending-output">searching…</div>
				{:else if isError}
					<div class="terminal-output error"><pre><code>{result.content}</code></pre></div>
				{:else if searchResults.length > 0}
					<ol class="search-results">
						{#each searchResults as r (r.index)}
							<li class="search-result">
								<a class="result-title" href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a>
								<div class="result-url">{r.url}</div>
								{#if r.snippet}<div class="result-snippet">{r.snippet}</div>{/if}
							</li>
						{/each}
					</ol>
				{:else}
					<!-- Fallback if parse yields nothing -->
					<pre class="raw-result"><code>{result.content}</code></pre>
				{/if}
			{:else}
				<div class="pending-output">searching…</div>
			{/if}

		<!-- ── file ops ── -->
		{:else if fileOpInput}
			<div class="file-path">
				<span class="path-label">{toolLabel}</span>
				<span class="path-val">{fileOpInput.path ?? ''}</span>
			</div>
			{#if call.name === 'sandbox_write_file' && fileOpInput.content != null}
				<div class="code-section">
					<div class="output-label">content</div>
					<pre class="code-block"><code>{fileOpInput.content}</code></pre>
				</div>
			{/if}
			{#if result}
				<div class="terminal-output{isError ? ' error' : ''}">
					<pre><code>{result.content}</code></pre>
				</div>
			{:else}
				<div class="pending-output">running…</div>
			{/if}

		<!-- ── generic fallback ── -->
		{:else}
			<div class="generic-section">
				<div class="output-label">input</div>
				<pre class="code-block"><code>{JSON.stringify(call.input ?? {}, null, 2)}</code></pre>
			</div>
			{#if result}
				<div class="generic-section">
					<div class="output-label">result</div>
					<pre class="code-block{isError ? ' error' : ''}"><code>{result.content}</code></pre>
				</div>
			{:else}
				<div class="pending-output">running…</div>
			{/if}
		{/if}
	</div>
</details>

<style>
	.tool-call {
		font-size: 0.875em;
		border: 1px solid var(--border-soft);
		border-radius: var(--bs-border-radius);
		background: var(--bs-body-bg);
		overflow: hidden;
	}

	.tool-call.nested {
		border: none;
		border-radius: 0;
		background: transparent;
	}

	/* ── Summary row ── */
	.tool-call summary {
		cursor: pointer;
		list-style: none;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.6rem;
		user-select: none;
	}

	.tool-call summary::-webkit-details-marker,
	.tool-call summary::marker {
		display: none;
		content: '';
	}

	.tool-call[open] summary {
		border-bottom: 1px solid var(--border-soft);
	}

	.chevron {
		font-size: 0.65em;
		color: var(--muted-2);
		transition: transform 100ms ease;
		flex-shrink: 0;
	}

	.tool-call[open] .chevron {
		transform: rotate(90deg);
	}

	.tool-label {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
		flex-shrink: 0;
	}

	.tool-headline {
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 0.82em;
		color: var(--fg);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	/* ── Status badge ── */
	.status {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}

	.status.running {
		color: var(--accent);
	}

	.status.error {
		color: var(--error-fg);
		font-weight: 600;
	}

	.status.done {
		color: var(--muted-2);
	}

	.dot {
		font-size: 0.7em;
		animation: pulse 1.1s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 1; }
	}

	/* ── Body ── */
	.tool-body {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding: 0.5rem 0.65rem;
	}

	/* ── Exec-specific ── */
	.exec-meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.3rem 0.5rem;
		background: var(--code-block-bg);
		border-radius: var(--bs-border-radius-sm);
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 0.85em;
	}

	.terminal-line {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
	}

	.prompt {
		color: var(--accent);
		font-weight: bold;
		flex-shrink: 0;
		padding-top: 0.05em;
	}

	.cmd {
		color: var(--code-block-fg);
		white-space: pre-wrap;
		word-break: break-all;
	}

	.meta-row {
		display: flex;
		gap: 0.4rem;
		font-size: 0.85em;
		color: var(--muted);
	}

	.meta-key {
		color: var(--muted-2);
		flex-shrink: 0;
	}

	.meta-val {
		color: var(--muted);
		word-break: break-all;
	}

	.exit-badge {
		display: inline-flex;
		align-items: center;
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 0.75em;
		font-weight: 600;
		padding: 0.1em 0.5em;
		border-radius: 999px;
		width: fit-content;
	}

	.exit-badge.ok {
		background: color-mix(in srgb, var(--bs-success) 15%, transparent);
		color: var(--bs-success);
	}

	.exit-badge.fail {
		background: color-mix(in srgb, var(--error-fg) 15%, transparent);
		color: var(--error-fg);
	}

	/* ── Terminal output ── */
	.terminal-output {
		background: var(--code-block-bg);
		border-radius: var(--bs-border-radius-sm);
		overflow-x: auto;
	}

	.terminal-output pre {
		margin: 0;
		padding: 0.45rem 0.6rem;
		font-size: 0.82em;
		color: var(--code-block-fg);
		white-space: pre-wrap;
		word-break: break-all;
	}

	.terminal-output pre code {
		background: none;
		padding: 0;
		font-size: inherit;
		color: inherit;
	}

	.terminal-output.streaming pre {
		color: var(--muted);
	}

	.terminal-output.error pre {
		color: var(--error-fg);
	}

	.output-section {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.output-label {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-2);
		font-weight: 600;
	}

	.output-label.stderr {
		color: color-mix(in srgb, var(--error-fg) 70%, var(--muted-2));
	}

	.pending-output {
		font-style: italic;
		color: var(--muted);
		font-size: 0.85em;
		padding: 0.15rem 0;
	}

	.empty-output {
		font-style: italic;
		color: var(--muted-2);
		font-size: 0.82em;
		padding: 0.15rem 0;
	}

	/* ── Code block (input display) ── */
	.code-section {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.code-block {
		margin: 0;
		padding: 0.45rem 0.6rem;
		font-size: 0.82em;
		background: var(--code-block-bg);
		color: var(--code-block-fg);
		border-radius: var(--bs-border-radius-sm);
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.code-block.error {
		color: var(--error-fg);
	}

	.code-block code {
		background: none;
		padding: 0;
		font-size: inherit;
		color: inherit;
	}

	/* ── Web search ── */
	.search-query {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.9em;
		color: var(--fg);
		padding: 0.1rem 0;
	}

	.search-icon {
		color: var(--accent);
		font-size: 1.1em;
		line-height: 1;
	}

	.meta-note {
		color: var(--muted);
		font-size: 0.85em;
	}

	.search-results {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.search-result {
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--border-soft);
		border-radius: var(--bs-border-radius-sm);
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.result-title {
		font-size: 0.9em;
		font-weight: 600;
		color: var(--accent);
		text-decoration: none;
		line-height: 1.3;
	}

	.result-title:hover {
		text-decoration: underline;
	}

	.result-url {
		font-size: 0.72em;
		color: var(--muted-2);
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.result-snippet {
		font-size: 0.82em;
		color: var(--muted);
		line-height: 1.4;
	}

	.raw-result {
		margin: 0;
		padding: 0.45rem 0.6rem;
		font-size: 0.82em;
		background: var(--code-block-bg);
		color: var(--code-block-fg);
		border-radius: var(--bs-border-radius-sm);
		overflow-x: auto;
		white-space: pre-wrap;
	}

	/* ── File ops ── */
	.file-path {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 0.85em;
		padding: 0.1rem 0;
	}

	.path-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-2);
		font-family: inherit;
	}

	.path-val {
		color: var(--fg);
		word-break: break-all;
	}

	/* ── Generic ── */
	.generic-section {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
</style>
