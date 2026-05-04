import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
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
		readability: {
			type: 'boolean',
			description:
				'When the response is HTML, extract the article body via Readability (Mozilla\'s reader-mode engine) and return its plain text. Defaults to true. Set to false to receive the raw HTML.',
		},
	},
	required: ['url'],
} as const;

function isHtml(contentType: string | null): boolean {
	if (!contentType) return false;
	const lower = contentType.toLowerCase();
	return lower.includes('text/html') || lower.includes('application/xhtml+xml');
}

// Inject a <base href> into the markup before parsing so any relative URLs
// Readability records resolve against the source page. Cheap and robust:
// adding to the start of <head> is well-formed HTML and Readability only
// reads what's already there.
function injectBaseHref(html: string, url: string): string {
	const baseTag = `<base href="${url.replace(/"/g, '&quot;')}">`;
	if (/<head[\s>]/i.test(html)) {
		return html.replace(/<head([\s>])/i, `<head$1${baseTag}`);
	}
	return baseTag + html;
}

function extractWithReadability(html: string, url: string): { content: string; title: string | null } | null {
	// Workers can't run jsdom (it pulls in `node:vm`/`node:fs`), so we use
	// linkedom — a lightweight DOM that ships its own HTML parser and works
	// in workerd. Readability only needs the standard query/traversal APIs,
	// which linkedom implements faithfully.
	try {
		const { document } = parseHTML(injectBaseHref(html, url));
		// Readability's typings expect the lib-DOM `Document`; linkedom's
		// document is structurally compatible for the methods Readability
		// calls. The cast keeps both type checkers happy.
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();
		if (!article) return null;
		const text = article.textContent?.trim() ?? '';
		if (!text) return null;
		const parts: string[] = [];
		if (article.title) parts.push(`# ${article.title}`);
		if (article.byline) parts.push(`_${article.byline}_`);
		if (article.siteName) parts.push(`(${article.siteName})`);
		parts.push('', text);
		return { content: parts.join('\n'), title: article.title ?? null };
	} catch {
		return null;
	}
}

export const fetchUrlTool: Tool = {
	definition: {
		name: 'fetch_url',
		description:
			'Fetch the contents of a URL over HTTP(S). For HTML pages the article body is extracted with Readability by default (compact, model-friendly text). Pass `readability: false` to receive raw HTML instead. Useful for retrieving the contents of a specific known URL.',
		inputSchema: fetchUrlInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as { url?: string; max_bytes?: number; readability?: boolean };
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
		const useReadability = args.readability !== false;
		try {
			const res = await fetch(parsed.toString(), {
				headers: { 'User-Agent': 'Interface/0.0 (+https://github.com/piperswe/interface)' },
				redirect: 'follow',
				signal: ctx.signal,
			});
			const contentType = res.headers.get('content-type');
			const { text, originalBytes, hitCap } = await readBodyWithCap(res, cap);

			let body = text;
			let mode = 'raw';
			if (useReadability && res.ok && isHtml(contentType) && !hitCap) {
				// Skip Readability when we hit the cap — partial HTML breaks the
				// parser and the truncated raw text is more useful than nothing.
				const extracted = extractWithReadability(text, parsed.toString());
				if (extracted) {
					body = extracted.content;
					mode = 'readability';
				}
			}

			const truncated = hitCap
				? body.slice(0, cap) + `\n…[truncated, original ≥${originalBytes} bytes]`
				: body.length > cap
					? body.slice(0, cap) + `\n…[truncated, original ${body.length} bytes]`
					: body;
			const header = `HTTP ${res.status} ${res.statusText} (${contentType ?? 'unknown'}; mode=${mode})`;
			return {
				content: `${header}\n\n${truncated}`,
				isError: !res.ok,
			};
		} catch (e) {
			return { content: e instanceof Error ? e.message : String(e), isError: true };
		}
	},
};

// Read the response body up to `cap` bytes and stop. Avoids loading hostile
// or huge origins into memory: we cancel the underlying reader as soon as
// the cap is reached.
async function readBodyWithCap(
	res: Response,
	cap: number,
): Promise<{ text: string; originalBytes: number; hitCap: boolean }> {
	if (!res.body) {
		const text = await res.text();
		const hitCap = text.length > cap;
		return { text: hitCap ? text.slice(0, cap) : text, originalBytes: text.length, hitCap };
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	let hitCap = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;
			bytes += value.byteLength;
			if (bytes < cap) {
				text += decoder.decode(value, { stream: true });
				continue;
			}
			// We've reached or passed the cap on this chunk. Trim to the cap
			// and stop; the body is at least `bytes` long and `hitCap` is true
			// even when the trim point falls exactly on a chunk boundary.
			const overshoot = bytes - cap;
			const trimmed = overshoot > 0 ? value.subarray(0, value.byteLength - overshoot) : value;
			text += decoder.decode(trimmed, { stream: true });
			hitCap = true;
			break;
		}
		text += decoder.decode();
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* ignore */
		}
	}
	return { text, originalBytes: bytes, hitCap };
}
