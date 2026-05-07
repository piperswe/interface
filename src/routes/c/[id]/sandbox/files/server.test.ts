import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { expectError } from '../../../../../../test/helpers';
import { GET } from './+server';

const VALID_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

type FileNode = { path: string; type: 'file' | 'directory' };

const bucket = env.WORKSPACE_BUCKET!;

afterEach(async () => {
	let cursor: string | undefined;
	do {
		const page = await bucket.list({
			prefix: `conversations/${VALID_ID}/`,
			cursor,
		});
		for (const obj of page.objects) await bucket.delete(obj.key);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
});

async function callGet(conversationId: string, search: string): Promise<Response> {
	const url = new URL(`http://localhost/c/${conversationId}/sandbox/files?${search}`);
	const event = {
		params: { id: conversationId },
		url,
		platform: { env },
		request: new Request(url.toString()),
	} as Parameters<typeof GET>[0];
	return GET(event);
}

describe('sandbox/files +server.ts — GET', () => {
	it('rejects malformed conversation ids with 404', async () => {
		await expectError(callGet('not-a-uuid', 'path=/workspace'), 404);
	});

	it('rejects paths outside /workspace with 400', async () => {
		await expectError(callGet(VALID_ID, 'path=/etc'), 400);
	});

	it('lists files and directories at /workspace, sorted', async () => {
		await bucket.put(`conversations/${VALID_ID}/zeta.txt`, 'z');
		await bucket.put(`conversations/${VALID_ID}/alpha.txt`, 'a');
		await bucket.put(`conversations/${VALID_ID}/sub/deep.md`, 'm');
		const res = await callGet(VALID_ID, 'path=/workspace');
		expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
		const list = (await res.json()) as FileNode[];
		const paths = list.map((n) => `${n.type}:${n.path}`);
		expect(paths).toEqual([
			'file:/workspace/alpha.txt',
			'directory:/workspace/sub',
			'file:/workspace/zeta.txt',
		]);
	});

	it('lists nested entries under /workspace/sub', async () => {
		await bucket.put(`conversations/${VALID_ID}/sub/a.txt`, 'a');
		await bucket.put(`conversations/${VALID_ID}/sub/b/inner.txt`, 'b');
		const res = await callGet(VALID_ID, 'path=/workspace/sub');
		const list = (await res.json()) as FileNode[];
		expect(list).toEqual([
			{ path: '/workspace/sub/a.txt', type: 'file' },
			{ path: '/workspace/sub/b', type: 'directory' },
		]);
	});

	it('returns an empty list when the conversation has no objects', async () => {
		const res = await callGet(VALID_ID, 'path=/workspace');
		expect(await res.json()).toEqual([]);
	});

	it('paginates across multiple R2 list pages', async () => {
		// R2 returns up to 1000 objects per page by default; force a multi-page
		// listing by overshooting that.
		const total = 1100;
		const writes: Promise<unknown>[] = [];
		for (let i = 0; i < total; i++) {
			writes.push(
				bucket.put(
					`conversations/${VALID_ID}/file-${String(i).padStart(4, '0')}.txt`,
					'x',
				),
			);
		}
		await Promise.all(writes);
		const res = await callGet(VALID_ID, 'path=/workspace');
		const list = (await res.json()) as FileNode[];
		expect(list.length).toBe(total);
	}, 60_000);
});
