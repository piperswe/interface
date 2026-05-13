import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDefined } from '../../../../../../test/assert-defined';
import { GET } from './+server';

const VALID_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// `wrangler.test.jsonc` binds WORKSPACE_BUCKET, so it's never undefined here.
assertDefined(env.WORKSPACE_BUCKET, 'WORKSPACE_BUCKET binding required');
const bucket = env.WORKSPACE_BUCKET;

afterEach(async () => {
	const list = await bucket.list({ prefix: `conversations/${VALID_ID}/` });
	for (const obj of list.objects) {
		await bucket.delete(obj.key);
	}
});

async function callGet(conversationId: string, search: string): Promise<Response> {
	const url = new URL(`http://localhost/c/${conversationId}/sandbox/file?${search}`);
	const event = {
		params: { id: conversationId },
		platform: { env },
		request: new Request(url.toString()),
		url,
	} as Parameters<typeof GET>[0];
	return GET(event);
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

describe('sandbox/file +server.ts — GET', () => {
	it('rejects malformed conversation ids with 404', async () => {
		await expectError(callGet('not-a-uuid', 'path=/workspace/foo.txt'), 404);
	});

	it('rejects paths outside /workspace/ with 400', async () => {
		await expectError(callGet(VALID_ID, 'path=/etc/passwd'), 400);
		await expectError(callGet(VALID_ID, 'path='), 400);
	});

	// Regression: `startsWith('/workspace/')` alone let `..` segments through.
	// Today's R2 backend treats keys as opaque flat strings (so the lookup just
	// misses), but any backend that normalises paths would turn this into a
	// cross-conversation read. Reject defensively before constructing the key.
	it('rejects paths containing `..` segments with 400', async () => {
		await expectError(callGet(VALID_ID, 'path=/workspace/../etc/passwd'), 400);
		await expectError(callGet(VALID_ID, 'path=/workspace/foo/../../bar'), 400);
		await expectError(callGet(VALID_ID, 'path=/workspace/..'), 400);
	});

	it('returns 404 when the R2 object does not exist', async () => {
		await expectError(callGet(VALID_ID, 'path=/workspace/missing.txt'), 404);
	});

	it('returns the body with text/plain for .txt', async () => {
		await bucket.put(`conversations/${VALID_ID}/note.txt`, 'hello world');
		const res = await callGet(VALID_ID, 'path=/workspace/note.txt');
		expect(res.headers.get('Content-Type')).toBe('text/plain');
		expect(await res.text()).toBe('hello world');
	});

	it('uses application/json for .json files', async () => {
		await bucket.put(`conversations/${VALID_ID}/data.json`, '{"a":1}');
		const res = await callGet(VALID_ID, 'path=/workspace/data.json');
		expect(res.headers.get('Content-Type')).toBe('application/json');
	});

	it('falls back to application/octet-stream for unknown extensions', async () => {
		await bucket.put(`conversations/${VALID_ID}/binary.xyzunknown`, 'bytes');
		const res = await callGet(VALID_ID, 'path=/workspace/binary.xyzunknown');
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
	});

	it('image/png for .png', async () => {
		await bucket.put(`conversations/${VALID_ID}/img.png`, new Uint8Array([1, 2, 3]));
		const res = await callGet(VALID_ID, 'path=/workspace/img.png');
		expect(res.headers.get('Content-Type')).toBe('image/png');
	});

	it('sets Content-Disposition for download=1 with ASCII fallback + UTF-8 encoded copy', async () => {
		await bucket.put(`conversations/${VALID_ID}/report.txt`, 'body');
		const res = await callGet(VALID_ID, 'path=/workspace/report.txt&download=1');
		const cd = res.headers.get('Content-Disposition') ?? '';
		expect(cd).toMatch(/^attachment;/);
		expect(cd).toContain('filename="report.txt"');
		expect(cd).toContain("filename*=UTF-8''");
	});

	it('Content-Disposition handles non-ASCII filenames', async () => {
		// Non-ASCII filename — store under any safe ASCII key so R2 is happy.
		await bucket.put(`conversations/${VALID_ID}/résumé.pdf`, 'body');
		const res = await callGet(VALID_ID, 'path=/workspace/résumé.pdf&download=1');
		const cd = res.headers.get('Content-Disposition') ?? '';
		// Non-ASCII chars are stripped/replaced in the ASCII fallback…
		expect(cd).toMatch(/filename="r_sum_\.pdf"/);
		// …and round-tripped via percent-encoding in the UTF-8 copy.
		expect(cd).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
	});

	it('omits Content-Disposition when download is not requested', async () => {
		await bucket.put(`conversations/${VALID_ID}/n.txt`, 'b');
		const res = await callGet(VALID_ID, 'path=/workspace/n.txt');
		expect(res.headers.get('Content-Disposition')).toBeNull();
	});
});
