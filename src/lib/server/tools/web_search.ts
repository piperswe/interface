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
				return { content: 'Missing required parameter: query', isError: true };
			}
			const response = await backend.search(args.query, {
				count: args.count ?? 5,
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
			response.results.forEach((r, i) => {
				const idx = i + 1;
				lines.push(`\n[${idx}] ${r.title}\n  ${r.url}\n  ${r.snippet}`);
				citations.push({ url: r.url, title: r.title, snippet: r.snippet });
			});
			return { content: lines.join('\n'), citations };
		},
	};
}
