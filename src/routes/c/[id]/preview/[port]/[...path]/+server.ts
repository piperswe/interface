import { error } from '@sveltejs/kit';
import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { RequestHandler } from './$types';

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

	// The Sandbox DO routes by hostname pattern `{port}-{id}-{token}.{host}`.
	// Reconstruct that hostname so the DO knows which container port to hit.
	const token = 'preview';
	const previewHostname = `${port}-${conversationId}-${token}.${hostname}`;
	const targetPath = '/' + (params.path ?? '');
	const previewUrl = new URL(targetPath, `http://${previewHostname}`);

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
