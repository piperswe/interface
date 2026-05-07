import { error, json } from '@sveltejs/kit';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import { DEFAULT_BINARY_MIME, mimeTypeForPath } from '$lib/server/sandbox-mime';
import type { RequestHandler } from './$types';

// Hard cap for ENT accounts, which support up to 500 MB request bodies.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function stripControlChars(s: string): string {
	let out = '';
	for (const ch of s) {
		const c = ch.charCodeAt(0);
		// Skip ASCII control chars (U+0000-U+001F and U+007F).
		if (c < 0x20 || c === 0x7f) continue;
		out += ch;
	}
	return out;
}

// Strip path separators, reject anything that looks like a traversal, and
// collapse whitespace to underscores. Returns a safe basename ready to be
// appended after our timestamp prefix.
function sanitizeFilename(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.includes('..')) return null;
	// Take only the basename - slashes/backslashes from the client are dropped.
	const last = trimmed.split(/[\/\\]/).pop() ?? '';
	const cleaned = stripControlChars(last).replace(/\s+/g, '_');
	if (!cleaned || cleaned === '.' || cleaned === '..') return null;
	// Cap length to avoid pathological R2 keys.
	return cleaned.slice(0, 240);
}

// Streams `request.body` directly into R2. The file is placed at
// `conversations/{id}/uploads/{timestamp}-{filename}` so concurrent picks of
// the same name don't overwrite. Returned `path` is the `/workspace`-rooted
// path the agent uses inside the sandbox.
export const POST: RequestHandler = async ({ params, url, request, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const bucket = platform.env.WORKSPACE_BUCKET;
	if (!bucket) error(503, 'workspace bucket not configured');

	const filenameParam = url.searchParams.get('filename');
	if (!filenameParam) error(400, 'filename query param required');
	const filename = sanitizeFilename(filenameParam);
	if (!filename) error(400, 'invalid filename');

	const contentLengthHeader = request.headers.get('content-length');
	const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : NaN;
	if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
		error(413, `file too large (max ${MAX_UPLOAD_BYTES} bytes)`);
	}

	if (!request.body) error(400, 'request body required');

	const headerContentType = request.headers.get('content-type') ?? '';
	// Browsers default unknown POST bodies to `application/octet-stream` for
	// raw uploads. Prefer the request header when it's not the generic
	// fallback, otherwise fall back to extension lookup.
	const mimeType =
		headerContentType && headerContentType !== DEFAULT_BINARY_MIME
			? headerContentType
			: mimeTypeForPath(filename);

	const timestamp = Date.now();
	const relativePath = `uploads/${timestamp}-${filename}`;
	const key = `conversations/${conversationId}/${relativePath}`;

	const put = await bucket.put(key, request.body, {
		httpMetadata: { contentType: mimeType },
	});
	if (!put) error(500, 'upload failed');

	return json({
		path: `/workspace/${relativePath}`,
		size: put.size,
		mimeType,
	});
};
