import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessagePart } from '$lib/types/conversation';
import { assertDefined } from '../../../../../test/assert-defined';
import { isBlobSentinel, offloadLargeBlobs, partsFromJson, partsToJson, resolveBlobRefs } from './blob-store';

assertDefined(env.WORKSPACE_BUCKET, 'WORKSPACE_BUCKET binding required');
const bucket = env.WORKSPACE_BUCKET;

async function clearBlobs(): Promise<void> {
	const list = await bucket.list({ prefix: 'blobs/' });
	for (const obj of list.objects) {
		await bucket.delete(obj.key);
	}
}

beforeEach(clearBlobs);
afterEach(clearBlobs);

// Build a base64 string of approximately `bytes` bytes by repeating a pattern.
// 4 base64 chars encode 3 raw bytes; round up.
function bigBase64(bytes: number): string {
	const target = Math.ceil(bytes / 3) * 4;
	let s = '';
	while (s.length < target) s += 'AAAA';
	return s.slice(0, target);
}

describe('blob-store', () => {
	it('offloads image data over the threshold and inlines small data', async () => {
		// Regression: SQLITE_TOOBIG when a single tool_result with a base64-encoded
		// image pushed the persisted parts JSON over SQLite's per-value cap.
		const big = bigBase64(300 * 1024); // 300 KB > 256 KB threshold
		const small = bigBase64(1024); // 1 KB < threshold
		const parts: MessagePart[] = [
			{
				content: [
					{ text: 'loaded', type: 'text' },
					{ data: big, mimeType: 'image/png', type: 'image' },
					{ data: small, mimeType: 'image/png', type: 'image' },
				],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const offloaded = await offloadLargeBlobs(parts, env);
		const tr = offloaded[0];
		if (tr.type !== 'tool_result' || typeof tr.content === 'string') throw new Error('shape');
		const blocks = tr.content;
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toEqual({ text: 'loaded', type: 'text' });
		const bigBlock = blocks[1];
		const smallBlock = blocks[2];
		if (bigBlock.type !== 'image' || smallBlock.type !== 'image') throw new Error('shape');
		expect(isBlobSentinel(bigBlock.data)).toBe(true);
		expect(isBlobSentinel(smallBlock.data)).toBe(false);
		expect(smallBlock.data).toBe(small);
	});

	it('round-trips through partsToJson/partsFromJson preserving image bytes', async () => {
		const big = bigBase64(400 * 1024);
		const parts: MessagePart[] = [
			{ text: 'before image', type: 'text' },
			{
				content: [{ data: big, mimeType: 'image/jpeg', type: 'image' }],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const json = await partsToJson(parts, env);
		expect(json).not.toBeNull();
		assertDefined(json);
		// The persisted JSON must NOT contain the full base64 payload — that's
		// the whole point of offloading.
		expect(json.length).toBeLessThan(big.length);
		expect(json).toContain('r2-blob:');
		const restored = await partsFromJson(json, env);
		expect(restored).toEqual(parts);
	});

	it('content-addresses identical bytes to the same R2 key', async () => {
		const big = bigBase64(300 * 1024);
		const parts1: MessagePart[] = [
			{
				content: [{ data: big, mimeType: 'image/png', type: 'image' }],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const parts2: MessagePart[] = [
			{
				content: [{ data: big, mimeType: 'image/png', type: 'image' }],
				isError: false,
				toolUseId: 't2',
				type: 'tool_result',
			},
		];
		await offloadLargeBlobs(parts1, env);
		await offloadLargeBlobs(parts2, env);
		const list = await bucket.list({ prefix: 'blobs/' });
		expect(list.objects).toHaveLength(1);
	});

	it('skips redundant R2 puts when the hash cache already knows the blob', async () => {
		const big = bigBase64(300 * 1024);
		const parts: MessagePart[] = [
			{
				content: [{ data: big, mimeType: 'image/png', type: 'image' }],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const cache = new Set<string>();
		await offloadLargeBlobs(parts, env, cache);
		expect(cache.size).toBe(1);
		// Drop the blob from R2 to prove the second call short-circuits via the
		// cache rather than re-uploading.
		const list = await bucket.list({ prefix: 'blobs/' });
		for (const obj of list.objects) await bucket.delete(obj.key);
		await offloadLargeBlobs(parts, env, cache);
		const after = await bucket.list({ prefix: 'blobs/' });
		expect(after.objects).toHaveLength(0);
	});

	it('returns the input array unchanged when there are no large blobs', async () => {
		const parts: MessagePart[] = [
			{ text: 'hi', type: 'text' },
			{
				content: [{ data: 'AAAA', mimeType: 'image/png', type: 'image' }],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const out = await offloadLargeBlobs(parts, env);
		expect(out).toBe(parts);
	});

	it('does not double-offload an already-sentineled image', async () => {
		const big = bigBase64(300 * 1024);
		const parts: MessagePart[] = [
			{
				content: [{ data: big, mimeType: 'image/png', type: 'image' }],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const once = await offloadLargeBlobs(parts, env);
		const twice = await offloadLargeBlobs(once, env);
		expect(twice).toBe(once);
	});

	it('resolves a missing blob to empty data rather than crashing', async () => {
		// Regression: a blob deleted from R2 (lifecycle, manual cleanup) must
		// not break loading the conversation. Renderer shows broken image,
		// page still loads.
		const parts: MessagePart[] = [
			{
				content: [{ data: 'r2-blob:deadbeefcafebabe', mimeType: 'image/png', type: 'image' }],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const resolved = await resolveBlobRefs(parts, env);
		const tr = resolved[0];
		if (tr.type !== 'tool_result' || typeof tr.content === 'string') throw new Error('shape');
		const block = tr.content[0];
		if (block.type !== 'image') throw new Error('shape');
		expect(block.data).toBe('');
	});

	it('partsFromJson returns null for null input and tolerates malformed JSON', async () => {
		expect(await partsFromJson(null, env)).toBeNull();
		expect(await partsFromJson('not valid json', env)).toBeNull();
	});

	it('partsToJson returns null for an empty array (matches DB NULL convention)', async () => {
		expect(await partsToJson([], env)).toBeNull();
	});

	it('does not touch tool_result blocks whose content is a plain string', async () => {
		const parts: MessagePart[] = [{ content: 'plain text result', isError: false, toolUseId: 't1', type: 'tool_result' }];
		const json = await partsToJson(parts, env);
		expect(json).not.toContain('r2-blob:');
		const restored = await partsFromJson(json, env);
		expect(restored).toEqual(parts);
	});

	it('falls back to inline storage when WORKSPACE_BUCKET is missing', async () => {
		const big = bigBase64(300 * 1024);
		const parts: MessagePart[] = [
			{
				content: [{ data: big, mimeType: 'image/png', type: 'image' }],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		// Without a bucket the offload is a no-op; callers retain legacy
		// inline behavior so dev environments without R2 still work.
		const out = await offloadLargeBlobs(parts, {});
		expect(out).toBe(parts);
	});
});
