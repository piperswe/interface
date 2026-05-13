import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import type { WebSearchBackend } from '../search/types';
import type { Tool, ToolCitation, ToolContext, ToolExecutionResult } from './registry';

const inputArgsSchema = z.object({
	count: z.number().optional(),
	query: z.string(),
});

const inputSchema = {
	properties: {
		count: {
			description: 'Number of results to fetch (default 5).',
			maximum: 10,
			minimum: 1,
			type: 'integer',
		},
		query: { description: 'Search query.', type: 'string' },
	},
	required: ['query'],
	type: 'object',
} as const;

export function createWebSearchTool(backend: WebSearchBackend): Tool {
	return {
		definition: {
			description:
				'Search the web for up-to-date information. Returns a list of result snippets with titles and URLs. Use when the answer depends on current events or facts the assistant may not have memorized.',
			inputSchema,
			name: 'web_search',
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(inputArgsSchema, input);
			if (!parsed.ok) {
				return { content: `Invalid input: ${parsed.error}`, errorCode: 'invalid_input', isError: true };
			}
			const args = parsed.value;
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
				const c = { snippet: r.snippet, title: r.title, url: r.url };
				const idx = register(c);
				lines.push(`\n[${idx}] ${r.title}\n  ${r.url}\n  ${r.snippet}`);
			}
			lines.push(
				'\nCite specific claims inline using the [N] markers above (e.g. "Paris is the capital [1].") so the user can map each fact back to its source.',
			);
			// `result.citations` is only set on the legacy path; the production
			// path threads citations through `ctx.registerCitation`, which the
			// loop accumulates directly.
			return ctx.registerCitation ? { content: lines.join('\n') } : { citations, content: lines.join('\n') };
		},
	};
}
