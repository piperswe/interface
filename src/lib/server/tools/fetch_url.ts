import type { Tool, ToolContext, ToolExecutionResult } from './registry';

const MAX_BYTES = 256 * 1024;

const fetchUrlInputSchema = {
	type: 'object',
	properties: {
		url: { type: 'string', format: 'uri', description: 'Absolute URL to fetch.' },
		max_bytes: {
			type: 'integer',
			minimum: 1,
			maximum: MAX_BYTES,
			description: `Optional cap (default ${MAX_BYTES}). Bodies larger than this are truncated.`,
		},
	},
	required: ['url'],
} as const;

export const fetchUrlTool: Tool = {
	definition: {
		name: 'fetch_url',
		description: 'Fetch the contents of a URL over HTTP(S) and return the response body as text. Useful for retrieving the contents of a specific known URL.',
		inputSchema: fetchUrlInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as { url?: string; max_bytes?: number };
		if (!args.url || typeof args.url !== 'string') {
			return { content: 'Missing required parameter: url', isError: true };
		}
		let parsed: URL;
		try {
			parsed = new URL(args.url);
		} catch {
			return { content: `Invalid URL: ${args.url}`, isError: true };
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return { content: `Refusing to fetch non-HTTP URL: ${args.url}`, isError: true };
		}
		const cap = Math.min(args.max_bytes ?? MAX_BYTES, MAX_BYTES);
		try {
			const res = await fetch(parsed.toString(), {
				headers: { 'User-Agent': 'Interface/0.0 (+https://github.com/piperswe/interface)' },
				redirect: 'follow',
				signal: ctx.signal,
			});
			const text = await res.text();
			const truncated = text.length > cap ? text.slice(0, cap) + `\n…[truncated, original ${text.length} bytes]` : text;
			return {
				content: `HTTP ${res.status} ${res.statusText} (${res.headers.get('content-type') ?? 'unknown'})\n\n${truncated}`,
				isError: !res.ok,
			};
		} catch (e) {
			return { content: e instanceof Error ? e.message : String(e), isError: true };
		}
	},
};
