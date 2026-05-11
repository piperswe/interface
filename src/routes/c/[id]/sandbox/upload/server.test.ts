import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { POST, _sanitizeFilename } from './+server';

const VALID_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// `wrangler.test.jsonc` binds WORKSPACE_BUCKET so it's safe to assume it's
// present in tests.
const bucket = env.WORKSPACE_BUCKET!;

afterEach(async () => {
	const list = await bucket.list({ prefix: `conversations/${VALID_ID}/` });
	for (const obj of list.objects) {
		await bucket.delete(obj.key);
	}
});

async function callPost(
	conversationId: string,
	options: {
		filename?: string;
		body?: BodyInit | null;
		contentType?: string;
		contentLength?: number;
		omitContentLength?: boolean;
	} = {},
): Promise<Response> {
	const params = new URLSearchParams();
	if (options.filename != null) params.set('filename', options.filename);
	const url = new URL(`http://localhost/c/${conversationId}/sandbox/upload?${params}`);
	const headers = new Headers();
	if (options.contentType) headers.set('content-type', options.contentType);
	const body = options.body ?? 'hello';
	if (options.contentLength != null) {
		headers.set('content-length', String(options.contentLength));
	} else if (!options.omitContentLength) {
		// Auto-compute for the common case so tests don't have to.
		if (typeof body === 'string') {
			headers.set('content-length', String(new TextEncoder().encode(body).byteLength));
		} else if (body instanceof Uint8Array) {
			headers.set('content-length', String(body.byteLength));
		}
	}
	const request = new Request(url.toString(), {
		method: 'POST',
		headers,
		body,
	});
	const event = {
		params: { id: conversationId },
		url,
		platform: { env },
		request,
	} as Parameters<typeof POST>[0];
	return POST(event);
}

async function expectError(promise: Promise<unknown>, status: number): Promise<void> {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
	}
}

describe('sandbox/upload +server.ts — POST', () => {
	it('rejects malformed conversation ids with 404', async () => {
		await expectError(callPost('not-a-uuid', { filename: 'x.png' }), 404);
	});

	it('rejects when filename query param is missing', async () => {
		await expectError(callPost(VALID_ID), 400);
	});

	// Regression: the old guard `trimmed.includes('..')` rejected legitimate
	// names like `report.v..1.pdf`. The traversal threat is already neutralised
	// by `split(/[\/\\]/).pop()` (taking the basename), so the safer behaviour
	// is to strip path segments and accept the safe basename. The result here
	// lands under `uploads/{ts}-passwd` — `..` segments cannot escape.
	it('strips path-traversal segments down to the safe basename', async () => {
		const res = await callPost(VALID_ID, { filename: '../etc/passwd' });
		expect(res.ok).toBe(true);
		const body = (await res.json()) as { path: string };
		expect(body.path).toMatch(/^\/workspace\/uploads\/\d+-passwd$/);
	});

	it('rejects oversized uploads via Content-Length', async () => {
		await expectError(
			callPost(VALID_ID, {
				filename: 'big.bin',
				contentLength: 501 * 1024 * 1024,
			}),
			413,
		);
	});

	// Regression: an upload without `Content-Length` used to fall through the
	// size guard (`parseInt(null, 10) === NaN`, `Number.isFinite(NaN) === false`).
	// We now require Content-Length and reject with 411.
	it('rejects uploads with no Content-Length header (411)', async () => {
		await expectError(
			callPost(VALID_ID, { filename: 'x.bin', omitContentLength: true }),
			411,
		);
	});

	it('rejects non-numeric Content-Length with 400', async () => {
		await expectError(
			callPost(VALID_ID, { filename: 'x.bin', contentLength: '12abc' as unknown as number }),
			400,
		);
	});
});

describe('_sanitizeFilename', () => {
	it('accepts normal filenames', () => {
		expect(_sanitizeFilename('photo.png')).toBe('photo.png');
		expect(_sanitizeFilename('report.v1.pdf')).toBe('report.v1.pdf');
	});

	// Regression: the old guard `trimmed.includes('..')` over-rejected legitimate
	// names like `report.v..2.pdf`. Now we only reject after taking the basename,
	// and only if the basename itself is `..`.
	it('accepts names with double-dots embedded', () => {
		expect(_sanitizeFilename('version.1..2.txt')).toBe('version.1..2.txt');
	});

	it('rejects hidden files (leading dot)', () => {
		expect(_sanitizeFilename('.htaccess')).toBeNull();
		expect(_sanitizeFilename('.env')).toBeNull();
	});

	it('rejects "." and ".." basenames', () => {
		expect(_sanitizeFilename('.')).toBeNull();
		expect(_sanitizeFilename('..')).toBeNull();
		expect(_sanitizeFilename('foo/..')).toBeNull();
	});

	it('strips path separators down to the basename', () => {
		expect(_sanitizeFilename('sub/deeper/photo.png')).toBe('photo.png');
		expect(_sanitizeFilename('C:\\users\\me\\file.txt')).toBe('file.txt');
	});

	it('writes the body to R2 at conversations/{id}/uploads/{ts}-{name}', async () => {
		const res = await callPost(VALID_ID, {
			filename: 'photo.png',
			body: new Uint8Array([1, 2, 3, 4]),
			contentType: 'image/png',
		});
		expect(res.ok).toBe(true);
		const body = (await res.json()) as { path: string; size: number; mimeType: string };
		expect(body.path).toMatch(/^\/workspace\/uploads\/\d+-photo\.png$/);
		expect(body.size).toBe(4);
		expect(body.mimeType).toBe('image/png');

		// Verify the R2 object actually exists.
		const relative = body.path.slice('/workspace/'.length);
		const obj = await bucket.get(`conversations/${VALID_ID}/${relative}`);
		expect(obj).not.toBeNull();
		const got = new Uint8Array(await obj!.arrayBuffer());
		expect(Array.from(got)).toEqual([1, 2, 3, 4]);
		expect(obj!.httpMetadata?.contentType).toBe('image/png');
	});

	it('falls back to extension-based MIME when content-type is octet-stream', async () => {
		const res = await callPost(VALID_ID, {
			filename: 'note.txt',
			body: 'hello',
			contentType: 'application/octet-stream',
		});
		const body = (await res.json()) as { mimeType: string };
		expect(body.mimeType).toBe('text/plain');
	});

	it('strips slashes from filenames so the basename is what lands in R2', async () => {
		const res = await callPost(VALID_ID, {
			filename: 'sub/deeper/photo.png',
			body: 'x',
			contentType: 'image/png',
		});
		const body = (await res.json()) as { path: string };
		expect(body.path).toMatch(/^\/workspace\/uploads\/\d+-photo\.png$/);
	});
});
