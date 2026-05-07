import { error } from '@sveltejs/kit';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import { mimeTypeForPath } from '$lib/server/sandbox-mime';
import type { RequestHandler } from './$types';

// Reads a single file out of the R2 bucket backing /workspace. Streams the
// R2 object body straight back to the client.
export const GET: RequestHandler = async ({ params, url, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const path = url.searchParams.get('path') ?? '';
	if (!path.startsWith('/workspace/')) error(400, 'invalid path');

	const bucket = platform.env.WORKSPACE_BUCKET;
	if (!bucket) error(503, 'workspace bucket not configured');

	const key = `conversations/${conversationId}/${path.slice('/workspace/'.length)}`;
	const obj = await bucket.get(key);
	if (!obj) error(404, 'file not found');

	const headers: Record<string, string> = {
		'Content-Type': mimeTypeForPath(path),
	};
	if (url.searchParams.has('download')) {
		const filename = path.split('/').pop() ?? 'file';
		// RFC 5987: ASCII fallback (with quotes/backslashes escaped) plus a UTF-8
		// encoded copy so non-ASCII filenames survive without breaking the header.
		const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '\\$&');
		const utf8 = encodeURIComponent(filename);
		headers['Content-Disposition'] = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8}`;
	}

	return new Response(obj.body, { headers });
};
