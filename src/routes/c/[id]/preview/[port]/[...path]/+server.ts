import { error } from '@sveltejs/kit';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import { getSandboxInstance } from '$lib/server/sandbox';
import type { RequestHandler } from './$types';

// Build the upstream URL that hits the sandbox's preview hostname. Both
// backends route by hostname pattern `{port}-{id}-{token}.{host}`; we
// reconstruct that and preserve the original path + query string.
//
// Exported for unit testing — `new URL(path, base)` drops query strings if
// the path-component lacks them, which broke any sandboxed app that read
// URL params. Keeping this in a pure helper makes the regression case
// trivial to assert. The `_` prefix opts out of SvelteKit's `+server.ts`
// export validator, which would otherwise reject any export that isn't a
// recognised HTTP method.
export function _buildPreviewUrl(opts: {
	port: number;
	conversationId: string;
	hostname: string;
	path: string | undefined;
	search: string;
}): URL {
	const { port, conversationId, hostname, path, search } = opts;
	const token = 'preview';
	const previewHostname = `${port}-${conversationId}-${token}.${hostname}`;
	const targetPath = '/' + (path ?? '') + search;
	return new URL(targetPath, `http://${previewHostname}`);
}

// Strict port parser. `parseInt('3000abc', 10) === 3000`, so the original
// guard let trailing junk through — the actual `exposePort` call would
// quietly succeed with a normalised number while link templates upstream
// reflected the attacker-supplied form. Exported for unit testing.
export function _parsePreviewPort(raw: string): number | null {
	if (!/^[0-9]+$/.test(raw)) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0 || n > 65535) return null;
	return n;
}

// Inbound headers that we MUST strip before proxying into the sandbox
// container. The container is running LLM- or user-supplied code that the
// operator does not control; forwarding browser auth/cookies/IP hands the
// container the operator's session for the app and their real client IP.
const STRIPPED_HEADER_PREFIXES = ['x-forwarded-', 'cf-'];
const STRIPPED_HEADERS = new Set([
	'cookie',
	'authorization',
	'proxy-authorization',
	'x-real-ip',
	'forwarded',
]);

export function _buildSanitizedProxyRequest(targetUrl: URL, request: Request): Request {
	const headers = new Headers();
	for (const [name, value] of request.headers) {
		const lower = name.toLowerCase();
		if (STRIPPED_HEADERS.has(lower)) continue;
		if (STRIPPED_HEADER_PREFIXES.some((p) => lower.startsWith(p))) continue;
		headers.set(name, value);
	}
	// `new Request(url, init)` requires a mode-compatible body when method is
	// not GET/HEAD; passing `request.body` keeps the original ReadableStream.
	const init: RequestInit = {
		method: request.method,
		headers,
		redirect: 'manual',
	};
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		init.body = request.body;
		(init as RequestInit & { duplex?: string }).duplex = 'half';
	}
	return new Request(targetUrl, init);
}

async function proxyToPreview({ params, request, url, platform }: Parameters<RequestHandler>[0]) {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const port = _parsePreviewPort(params.port);
	if (port === null) error(400, 'invalid port');

	const instance = await getSandboxInstance(platform.env, conversationId);
	if (!instance) error(503, 'sandbox not configured');

	// Ensure the port is exposed with a stable token. Cloudflare's backend
	// hits the DO; fly's backend records the (port, token) tuple in D1 so
	// `getExposedPorts` can return the list later.
	const hostname = url.host;
	try {
		await instance.exposePort(port, { hostname, token: 'preview' });
	} catch (e) {
		// Already exposed with the same token — fine. Log for observability.
		console.warn('exposePort failed:', e instanceof Error ? e.message : String(e));
	}

	const previewUrl = _buildPreviewUrl({
		port,
		conversationId,
		hostname,
		path: params.path,
		search: url.search,
	});

	const proxyRequest = _buildSanitizedProxyRequest(previewUrl, request);
	return await instance.fetch(proxyRequest);
}

export const GET: RequestHandler = proxyToPreview;
export const POST: RequestHandler = proxyToPreview;
export const PUT: RequestHandler = proxyToPreview;
export const DELETE: RequestHandler = proxyToPreview;
export const PATCH: RequestHandler = proxyToPreview;
export const OPTIONS: RequestHandler = proxyToPreview;
export const HEAD: RequestHandler = proxyToPreview;
