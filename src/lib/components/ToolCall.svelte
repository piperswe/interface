<script lang="ts">
	import type { ToolCallRecord, ToolResultRecord } from '$lib/types/conversation';
	import { ChevronRight } from 'lucide-svelte';

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

	// Tool results can be a plain string or an array of text/image blocks
	// (e.g. `sandbox_load_image`). For UI display we flatten to a string so
	// existing render paths keep working; image entries are summarised.
	function flattenContent(c: string | { type: 'text'; text: string }[] | { type: 'image'; mimeType: string; data: string }[] | (
		| { type: 'text'; text: string }
		| { type: 'image'; mimeType: string; data: string }
	)[]): string {
		if (typeof c === 'string') return c;
		if (!Array.isArray(c)) return '';
		return c
			.map((b) => {
				if (b.type === 'text') return b.text;
				if (b.type === 'image') return `[image ${b.mimeType}, ${Math.round((b.data.length * 3) / 4)} bytes]`;
				return '';
			})
			.join('\n');
	}
	const resultText = $derived(result ? flattenContent(result.content) : '');

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

	const runJsInput = $derived(
		call.name === 'run_js' ? (call.input as { code?: string; timeout?: number }) : null,
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

	const loadImageInput = $derived(
		call.name === 'sandbox_load_image'
			? (call.input as { path?: string })
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
		call.name === 'sandbox_exec' && result && isDone ? parseExecResult(resultText) : null,
	);

	// Parse the structured run_js result
	type RunJsLog = { level: 'log' | 'warn' | 'error'; msg: string };
	type RunJsParsed = { logs: RunJsLog[]; result: string | null; error: string | null };
	function parseRunJsResult(content: string): RunJsParsed {
		const logs: RunJsLog[] = [];
		const resultLines: string[] = [];
		const errorLines: string[] = [];
		let section: 'none' | 'console' | 'result' | 'error' = 'none';
		for (const line of content.split('\n')) {
			if (line === '--- console ---') {
				section = 'console';
			} else if (line === '--- result ---') {
				section = 'result';
			} else if (line === '--- error ---') {
				section = 'error';
			} else if (section === 'console') {
				if (line === '') continue;
				const m = line.match(/^\[(warn|error)\] (.*)$/);
				if (m) {
					logs.push({ level: m[1] as 'warn' | 'error', msg: m[2] });
				} else {
					logs.push({ level: 'log', msg: line });
				}
			} else if (section === 'result') {
				resultLines.push(line);
			} else if (section === 'error') {
				errorLines.push(line);
			}
		}
		// Trim leading/trailing blank lines
		while (resultLines.length && resultLines[0] === '') resultLines.shift();
		while (resultLines.length && resultLines[resultLines.length - 1] === '') resultLines.pop();
		while (errorLines.length && errorLines[0] === '') errorLines.shift();
		while (errorLines.length && errorLines[errorLines.length - 1] === '') errorLines.pop();
		return {
			logs,
			result: resultLines.length ? resultLines.join('\n') : null,
			error: errorLines.length ? errorLines.join('\n') : null,
		};
	}

	const runJsParsed = $derived(
		call.name === 'run_js' && result && isDone ? parseRunJsResult(resultText) : null,
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
		call.name === 'web_search' && result && isDone ? parseSearchResults(resultText) : [],
	);

	type LoadImageParsed = {
		images: { mimeType: string; data: string }[];
		text: string;
	};
	function parseLoadImageResult(c: ToolResultRecord['content']): LoadImageParsed {
		if (typeof c === 'string') return { images: [], text: c };
		const images: { mimeType: string; data: string }[] = [];
		const texts: string[] = [];
		for (const b of c) {
			if (b.type === 'image') images.push({ mimeType: b.mimeType, data: b.data });
			else if (b.type === 'text') texts.push(b.text);
		}
		return { images, text: texts.join('\n') };
	}

	const loadImageParsed = $derived(
		call.name === 'sandbox_load_image' && result && isDone && !isError
			? parseLoadImageResult(result.content)
			: null,
	);

	function firstLine(s: string, max = 80): string {
		const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
		const trimmed = line.trim();
		return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
	}

	// Summary headline: the key "what is this doing" per tool
	const headline = $derived(
		execInput?.command
			? execInput.command.length > 80
				? execInput.command.slice(0, 78) + '…'
				: execInput.command
			: runJsInput?.code
				? firstLine(runJsInput.code)
				: runCodeInput?.code
					? (runCodeInput.language ?? 'python')
					: webSearchInput?.query
						? webSearchInput.query
						: fileOpInput?.path
							? fileOpInput.path
							: loadImageInput?.path
								? loadImageInput.path
								: null,
	);

	const toolLabel = $derived(
		call.name === 'sandbox_exec'
			? 'exec'
			: call.name === 'sandbox_run_code'
				? 'code'
				: call.name === 'run_js'
					? 'js'
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
											: call.name === 'sandbox_load_image'
												? 'image'
												: call.name,
	);

	const startedAt = $derived(result?.startedAt ?? call.startedAt ?? null);
	const endedAt = $derived(result?.endedAt ?? null);
	const latencyMs = $derived(startedAt != null && endedAt != null ? endedAt - startedAt : null);
	function fmtLatency(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
		const m = Math.floor(ms / 60_000);
		const s = Math.round((ms % 60_000) / 1000);
		return `${m}m${s}s`;
	}
	function fmtTimestamp(ts: number): string {
		try {
			return new Date(ts).toLocaleTimeString();
		} catch {
			return String(ts);
		}
	}
</script>

<details class="tool-call{nested ? ' nested' : ''}" data-tool-name={call.name} {open}>
	<summary>
		<ChevronRight class="chevron" size={12} aria-hidden="true" />
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
		{#if latencyMs != null}
			<span class="latency" title={`Started ${fmtTimestamp(startedAt!)} · ended ${fmtTimestamp(endedAt!)}`}>{fmtLatency(latencyMs)}</span>
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
						<pre><code>{resultText || ' '}</code></pre>
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
					<div class="terminal-output"><pre><code>{resultText}</code></pre></div>
				{/if}
			{:else}
				<div class="pending-output">waiting for output…</div>
			{/if}

		<!-- ── run_js ── -->
		{:else if call.name === 'run_js' && runJsInput}
			<div class="code-section">
				<div class="output-label">javascript</div>
				{#if call.inputHtml}
					<div class="code-block shiki-block">{@html call.inputHtml}</div>
				{:else}
					<pre class="code-block"><code>{runJsInput.code ?? ''}</code></pre>
				{/if}
				{#if runJsInput.timeout}
					<div class="meta-row">
						<span class="meta-key">timeout</span>
						<span class="meta-val">{runJsInput.timeout}ms</span>
					</div>
				{/if}
			</div>

			{#if result}
				{#if isStreaming}
					<div class="terminal-output streaming">
						<pre><code>{resultText || ' '}</code></pre>
					</div>
				{:else if runJsParsed}
					{#if runJsParsed.logs.length > 0}
						<div class="output-section">
							<div class="output-label">console</div>
							<div class="terminal-output">
								<pre><code>{#each runJsParsed.logs as l, i (i)}<span class="log-line log-{l.level}">{l.level === 'log' ? '' : `[${l.level}] `}{l.msg}</span>{'\n'}{/each}</code></pre>
							</div>
						</div>
					{/if}
					{#if runJsParsed.result != null}
						<div class="output-section">
							<div class="output-label">result</div>
							<div class="terminal-output"><pre><code>{runJsParsed.result}</code></pre></div>
						</div>
					{/if}
					{#if runJsParsed.error != null}
						<div class="output-section">
							<div class="output-label stderr">error</div>
							<div class="terminal-output error"><pre><code>{runJsParsed.error}</code></pre></div>
						</div>
					{/if}
					{#if runJsParsed.logs.length === 0 && runJsParsed.result == null && runJsParsed.error == null}
						<div class="empty-output">no output</div>
					{/if}
				{:else}
					<div class="terminal-output{isError ? ' error' : ''}"><pre><code>{resultText}</code></pre></div>
				{/if}
			{:else}
				<div class="pending-output">running…</div>
			{/if}

		<!-- ── sandbox_run_code ── -->
		{:else if call.name === 'sandbox_run_code' && runCodeInput}
			<div class="code-section">
				<div class="output-label">{runCodeInput.language ?? 'python'}</div>
				{#if call.inputHtml}
					<div class="code-block shiki-block">{@html call.inputHtml}</div>
				{:else}
					<pre class="code-block"><code>{runCodeInput.code ?? ''}</code></pre>
				{/if}
			</div>
			{#if result}
				<div class="output-section">
					<div class="output-label">output</div>
					<div class="terminal-output{isError ? ' error' : ''}">
						<pre><code>{resultText || "(no output)"}</code></pre>
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
					<div class="terminal-output error"><pre><code>{resultText}</code></pre></div>
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
					<pre class="raw-result"><code>{resultText}</code></pre>
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
					<pre><code>{resultText}</code></pre>
				</div>
			{:else}
				<div class="pending-output">running…</div>
			{/if}

		<!-- ── sandbox_load_image ── -->
		{:else if call.name === 'sandbox_load_image' && loadImageInput}
			<div class="file-path">
				<span class="path-label">image</span>
				<span class="path-val">{loadImageInput.path ?? ''}</span>
			</div>
			{#if !result || isStreaming}
				<div class="pending-output">loading…</div>
			{:else if isError}
				<div class="terminal-output error"><pre><code>{resultText}</code></pre></div>
			{:else if loadImageParsed && loadImageParsed.images.length > 0}
				<div class="image-previews">
					{#each loadImageParsed.images as img, i (i)}
						<img
							class="image-preview"
							src={`data:${img.mimeType};base64,${img.data}`}
							alt={loadImageInput.path ?? 'loaded image'}
							loading="lazy"
							decoding="async"
						/>
					{/each}
				</div>
				{#if loadImageParsed.text}
					<div class="meta-row"><span class="meta-val">{loadImageParsed.text}</span></div>
				{/if}
			{:else}
				<!-- non-vision-model fallback: content is a plain string -->
				<div class="terminal-output"><pre><code>{resultText}</code></pre></div>
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
					<pre class="code-block{isError ? ' error' : ''}"><code>{resultText}</code></pre>
				</div>
			{:else}
				<div class="pending-output">running…</div>
			{/if}
		{/if}

		{#if startedAt != null || result}
			<details class="tool-details">
				<summary><ChevronRight class="chevron" size={11} aria-hidden="true" />Details</summary>
				<dl class="detail-grid">
					<dt>name</dt><dd><code>{call.name}</code></dd>
					{#if startedAt != null}
						<dt>started</dt><dd>{fmtTimestamp(startedAt)}</dd>
					{/if}
					{#if endedAt != null}
						<dt>ended</dt><dd>{fmtTimestamp(endedAt)}</dd>
					{/if}
					{#if latencyMs != null}
						<dt>latency</dt><dd>{fmtLatency(latencyMs)}</dd>
					{/if}
					<dt>id</dt><dd><code>{call.id}</code></dd>
				</dl>
				<div class="output-label mt-2">raw input</div>
				<pre class="code-block"><code>{JSON.stringify(call.input ?? {}, null, 2)}</code></pre>
				{#if result}
					<div class="output-label mt-2">raw output</div>
					<pre class="code-block{isError ? ' error' : ''}"><code>{resultText}</code></pre>
				{/if}
			</details>
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

	.tool-call > summary :global(.chevron) {
		color: var(--muted-2);
		transition: transform 100ms ease;
		flex-shrink: 0;
	}

	.tool-call[open] > summary :global(.chevron) {
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

	.log-line {
		display: inline;
	}

	.log-line.log-warn {
		color: var(--bs-warning, #b58900);
	}

	.log-line.log-error {
		color: var(--error-fg);
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

	/* When the code-block wraps Shiki-rendered HTML, the inner <pre.shiki>
	   carries its own background and padding — flatten the outer wrapper. */
	.shiki-block {
		padding: 0;
		background: transparent;
	}

	.shiki-block :global(pre.shiki) {
		margin: 0;
		padding: 0.45rem 0.6rem;
		font-size: 0.82em;
		border-radius: var(--bs-border-radius-sm);
		overflow-x: auto;
	}

	.shiki-block :global(pre.shiki code) {
		background: none;
		padding: 0;
		font-size: inherit;
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

	.latency {
		font-size: 0.7rem;
		color: var(--muted-2);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	.tool-details {
		margin-top: 0.25rem;
		font-size: 0.85em;
	}

	.tool-details summary {
		cursor: pointer;
		color: var(--muted-2);
		padding: 0.2rem 0;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		list-style: none;
	}

	.tool-details summary::-webkit-details-marker,
	.tool-details summary::marker {
		display: none;
		content: '';
	}

	.tool-details summary :global(.chevron) {
		color: var(--muted-2);
		margin-right: 0.3rem;
		transition: transform 100ms ease;
		flex-shrink: 0;
		vertical-align: -1px;
	}

	.tool-details[open] summary :global(.chevron) {
		transform: rotate(90deg);
	}

	.detail-grid {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.15rem 0.6rem;
		margin: 0.25rem 0 0;
		font-size: 0.85em;
	}

	.detail-grid dt {
		color: var(--muted-2);
		font-weight: 500;
	}

	.detail-grid dd {
		margin: 0;
		color: var(--fg);
		word-break: break-all;
	}

	.image-previews {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		padding: 0.3rem;
		background: var(--code-block-bg);
		border-radius: var(--bs-border-radius-sm);
	}

	.image-preview {
		max-width: 100%;
		max-height: 320px;
		object-fit: contain;
		border: 1px solid var(--border-soft);
		border-radius: var(--bs-border-radius-sm);
		background: #000;
		display: block;
	}
</style>
