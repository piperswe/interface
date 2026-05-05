import { error } from '@sveltejs/kit';
import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';
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

export const GET: RequestHandler = async ({ params, url, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const path = url.searchParams.get('path') ?? '';
	if (!path || (!path.startsWith('/workspace') && !path.startsWith('/tmp'))) {
		error(400, 'invalid path');
	}
	if (!platform.env.SANDBOX) error(503, 'sandbox not configured');

	const ns = platform.env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>;
	const sandbox = getSandbox(ns, conversationId);

	const file = await sandbox.readFile(path);
	const isDownload = url.searchParams.has('download');

	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

	let body: Uint8Array | string;
	if (file.encoding === 'base64') {
		body = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
	} else {
		body = file.content;
	}

	const headers: Record<string, string> = {
		'Content-Type': contentType,
	};
	if (isDownload) {
		const filename = path.split('/').pop() ?? 'file';
		// RFC 5987: ASCII fallback (with quotes/backslashes escaped) plus a UTF-8
		// encoded copy so non-ASCII filenames survive without breaking the header.
		const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '\\$&');
		const utf8 = encodeURIComponent(filename);
		headers['Content-Disposition'] = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8}`;
	}

	return new Response(body as BodyInit, { headers });
};
