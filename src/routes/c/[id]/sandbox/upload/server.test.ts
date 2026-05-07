import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { expectError } from '../../../../../../test/helpers';
import { POST } from './+server';

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
	} = {},
): Promise<Response> {
	const params = new URLSearchParams();
	if (options.filename != null) params.set('filename', options.filename);
	const url = new URL(`http://localhost/c/${conversationId}/sandbox/upload?${params}`);
	const headers = new Headers();
	if (options.contentType) headers.set('content-type', options.contentType);
	if (options.contentLength != null) headers.set('content-length', String(options.contentLength));
	const request = new Request(url.toString(), {
		method: 'POST',
		headers,
		body: options.body ?? 'hello',
	});
	const event = {
		params: { id: conversationId },
		url,
		platform: { env },
		request,
	} as Parameters<typeof POST>[0];
	return POST(event);
}

describe('sandbox/upload +server.ts — POST', () => {
	it('rejects malformed conversation ids with 404', async () => {
		await expectError(callPost('not-a-uuid', { filename: 'x.png' }), 404);
	});

	it('rejects when filename query param is missing', async () => {
		await expectError(callPost(VALID_ID), 400);
	});

	it('rejects path-traversal attempts', async () => {
		await expectError(callPost(VALID_ID, { filename: '../etc/passwd' }), 400);
	});

	it('rejects oversized uploads via Content-Length', async () => {
		await expectError(
			callPost(VALID_ID, {
				filename: 'big.bin',
				contentLength: 100 * 1024 * 1024,
			}),
			413,
		);
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
