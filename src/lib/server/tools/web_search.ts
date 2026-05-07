import type { WebSearchBackend } from '../search/types';
import type { Tool, ToolCitation, ToolContext, ToolExecutionResult } from './registry';

const inputSchema = {
	type: 'object',
	properties: {
		query: { type: 'string', description: 'Search query.' },
		count: {
			type: 'integer',
			minimum: 1,
			maximum: 10,
			description: 'Number of results to fetch (default 5).',
		},
	},
	required: ['query'],
} as const;

export function createWebSearchTool(backend: WebSearchBackend): Tool {
	return {
		definition: {
			name: 'web_search',
			description:
				'Search the web for up-to-date information. Returns a list of result snippets with titles and URLs. Use when the answer depends on current events or facts the assistant may not have memorized.',
			inputSchema,
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const args = (input ?? {}) as { query?: string; count?: number };
			if (!args.query || typeof args.query !== 'string') {
				return { content: 'Missing required parameter: query', isError: true, errorCode: 'invalid_input' };
			}
			// Schema says count ∈ [1, 10] but the model is free to ignore it.
			// Clamp here so a bogus value never reaches the backend.
			const requestedCount = Number.isFinite(args.count) ? Math.floor(args.count as number) : 5;
			const count = Math.max(1, Math.min(10, requestedCount));
			const response = await backend.search(args.query, {
				count,
				signal: ctx.signal,
			});
			if (!response.ok) {
				return { content: `Search failed: ${response.error}`, isError: true };
			}
			if (response.results.length === 0) {
				return { content: `No results for "${args.query}".` };
			}
			const lines: string[] = [`Search results for "${args.query}":`];
			const citations: ToolCitation[] = [];
			// Numbering is globally stable across the turn when `registerCitation`
			// is provided (production path) — two `web_search` calls that hit the
			// same URL share the same index, and the model can reuse the index
			// inline. Without it (legacy / test path) we fall back to a per-call
			// 1-based count, which still matches the result text but doesn't
			// dedupe across calls.
			const seenLocal = new Map<string, number>();
			let localCounter = 0;
			const fallbackRegister = (c: ToolCitation): number => {
				const existing = seenLocal.get(c.url);
				if (existing !== undefined) return existing;
				localCounter += 1;
				seenLocal.set(c.url, localCounter);
				citations.push(c);
				return localCounter;
			};
			const register = ctx.registerCitation ?? fallbackRegister;
			for (const r of response.results) {
				const c = { url: r.url, title: r.title, snippet: r.snippet };
				const idx = register(c);
				lines.push(`\n[${idx}] ${r.title}\n  ${r.url}\n  ${r.snippet}`);
			}
			lines.push(
				'\nCite specific claims inline using the [N] markers above (e.g. "Paris is the capital [1].") so the user can map each fact back to its source.',
			);
			// `result.citations` is only set on the legacy path; the production
			// path threads citations through `ctx.registerCitation`, which the
			// loop accumulates directly.
			return ctx.registerCitation
				? { content: lines.join('\n') }
				: { content: lines.join('\n'), citations };
		},
	};
}
