import { error } from '@sveltejs/kit';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { RequestHandler } from './$types';

const MIME_TYPES: Record<string, string> = {
	txt: 'text/plain',
	md: 'text/markdown',
	js: 'application/javascript',
	jsx: 'application/javascript',
	ts: 'application/typescript',
	tsx: 'application/typescript',
	json: 'application/json',
	html: 'text/html',
	css: 'text/css',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	pdf: 'application/pdf',
	csv: 'text/csv',
	xml: 'application/xml',
	yaml: 'application/yaml',
	yml: 'application/yaml',
	py: 'text/x-python',
	sh: 'application/x-sh',
	toml: 'application/toml',
};

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

	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

	const headers: Record<string, string> = {
		'Content-Type': contentType,
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
