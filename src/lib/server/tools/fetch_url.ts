import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import { ipv4MappedOctets, ipv4OctetsArePrivate } from '../url-guard';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

const MAX_BYTES = 256 * 1024;

// SSRF guard: reject hosts that resolve to loopback, link-local, RFC 1918,
// cloud-metadata, or other reserved ranges. The LLM should not be able to
// fetch the worker's own routes or the operator's internal infrastructure.
// Shares its IPv4/IPv6 predicates with `url-guard.ts`'s throwing variant —
// the boolean shape here exists because `fetch_url` allows http:// in
// addition to https:// (the scheme check is one frame up in `urlIsSafe`).
// Exported for unit testing.
export function _hostIsPrivate(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.local')) {
		return true;
	}
	// IPv4 literal
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4 && ipv4OctetsArePrivate(Number(v4[1]), Number(v4[2]))) {
		return true;
	}
	// IPv6 literal — workerd surfaces these as bracketed.
	if (host.startsWith('[') || host.includes(':')) {
		const bare = host.replace(/^\[/, '').replace(/\]$/, '');
		if (bare === '::1' || bare === '::' || bare.startsWith('fc') || bare.startsWith('fd') || bare.startsWith('fe80:')) {
			return true;
		}
		const mapped = ipv4MappedOctets(bare);
		if (mapped && ipv4OctetsArePrivate(mapped[0], mapped[1])) {
			return true;
		}
	}
	return false;
}

function urlIsSafe(url: URL): boolean {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	if (_hostIsPrivate(url.hostname)) return false;
	return true;
}

const inputArgsSchema = z.object({
	max_bytes: z.number().optional(),
	readability: z.boolean().optional(),
	url: z.string(),
});

const fetchUrlInputSchema = {
	properties: {
		max_bytes: {
			description: `Optional cap (default ${MAX_BYTES}). Bodies larger than this are truncated.`,
			maximum: MAX_BYTES,
			minimum: 1,
			type: 'integer',
		},
		readability: {
			description:
				"When the response is HTML, extract the article body via Readability (Mozilla's reader-mode engine) and return its plain text. Defaults to true. Set to false to receive the raw HTML.",
			type: 'boolean',
		},
		url: { description: 'Absolute URL to fetch.', format: 'uri', type: 'string' },
	},
	required: ['url'],
	type: 'object',
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
		description:
			'Fetch the contents of a URL over HTTP(S). For HTML pages the article body is extracted with Readability by default (compact, model-friendly text). Pass `readability: false` to receive raw HTML instead. Useful for retrieving the contents of a specific known URL.',
		inputSchema: fetchUrlInputSchema,
		name: 'fetch_url',
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const validated = safeValidate(inputArgsSchema, input);
		if (!validated.ok) {
			return { content: `Invalid input: ${validated.error}`, errorCode: 'invalid_input', isError: true };
		}
		const args = validated.value;
		let parsed: URL;
		try {
			parsed = new URL(args.url);
		} catch {
			return { content: `Invalid URL: ${args.url}`, isError: true };
		}
		if (!urlIsSafe(parsed)) {
			return {
				content: `Refusing to fetch URL: ${args.url} (must be public http(s) — loopback / private / metadata IPs are blocked)`,
				isError: true,
			};
		}
		const cap = Math.min(args.max_bytes ?? MAX_BYTES, MAX_BYTES);
		const useReadability = args.readability !== false;
		try {
			// `redirect: 'manual'` so we can re-validate each redirect target
			// against the same SSRF guard. A naive `redirect: 'follow'` would
			// happily chase a 302 to http://169.254.169.254/.
			let current = parsed;
			let res: Response | null = null;
			for (let hop = 0; hop < 5; hop++) {
				res = await fetch(current.toString(), {
					headers: { 'User-Agent': 'Interface/0.0 (+https://github.com/piperswe/interface)' },
					redirect: 'manual',
					signal: ctx.signal,
				});
				if (res.status < 300 || res.status >= 400 || res.status === 304) break;
				const loc = res.headers.get('location');
				if (!loc) break;
				let next: URL;
				try {
					next = new URL(loc, current);
				} catch {
					return { content: `Invalid redirect target: ${loc}`, isError: true };
				}
				if (!urlIsSafe(next)) {
					return {
						content: `Refusing to follow redirect to ${next.href} (loopback / private / metadata IP)`,
						isError: true,
					};
				}
				current = next;
			}
			if (!res) {
				return { content: 'fetch_url: no response after redirect chain', isError: true };
			}
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
				? `${body.slice(0, cap)}\n…[truncated, original ≥${originalBytes} bytes]`
				: body.length > cap
					? `${body.slice(0, cap)}\n…[truncated, original ${body.length} bytes]`
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
async function readBodyWithCap(res: Response, cap: number): Promise<{ text: string; originalBytes: number; hitCap: boolean }> {
	if (!res.body) {
		const text = await res.text();
		const hitCap = text.length > cap;
		return { hitCap, originalBytes: text.length, text: hitCap ? text.slice(0, cap) : text };
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
	return { hitCap, originalBytes: bytes, text };
}
