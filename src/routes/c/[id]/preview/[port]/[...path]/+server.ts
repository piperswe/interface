import { error } from '@sveltejs/kit';
import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { RequestHandler } from './$types';

// Build the upstream URL that hits the Sandbox DO's preview hostname. The
// Sandbox routes by hostname pattern `{port}-{id}-{token}.{host}`; we
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

async function proxyToPreview({ params, request, url, platform }: Parameters<RequestHandler>[0]) {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const port = parseInt(params.port, 10);
	if (Number.isNaN(port) || port <= 0) error(400, 'invalid port');
	if (!platform.env.SANDBOX) error(503, 'sandbox not configured');

	const ns = platform.env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>;
	const sandbox = getSandbox(ns, conversationId);

	// Ensure the port is exposed with a stable token.
	const hostname = url.host;
	try {
		await sandbox.exposePort(port, { hostname, token: 'preview' });
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

	const id = ns.idFromName(conversationId);
	const stub = ns.get(id);
	const proxyRequest = new Request(previewUrl, request);
	return await stub.fetch(proxyRequest);
}

export const GET: RequestHandler = proxyToPreview;
export const POST: RequestHandler = proxyToPreview;
export const PUT: RequestHandler = proxyToPreview;
export const DELETE: RequestHandler = proxyToPreview;
export const PATCH: RequestHandler = proxyToPreview;
export const OPTIONS: RequestHandler = proxyToPreview;
export const HEAD: RequestHandler = proxyToPreview;
