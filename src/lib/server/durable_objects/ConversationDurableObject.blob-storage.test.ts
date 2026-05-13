// End-to-end regression for the SQLITE_TOOBIG bug that fired when an
// assistant turn included a large base64-encoded image (e.g. from
// `sandbox_load_image`). The persisted `parts` JSON would push the row's
// per-value size past SQLite's 2 MB cap and the whole conversation would
// fail to save. The blob-store layer offloads large image bytes to R2
// content-addressed at `blobs/<sha256>` and persists a tiny sentinel
// (`r2-blob:<sha256>`) inline; reads transparently re-inline the bytes.

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessagePart } from '$lib/types/conversation';
import { assertDefined } from '../../../../test/assert-defined';
import { createConversation } from '../conversations';
import { readState, stubFor } from './conversation/_test-helpers';
import { partsFromJson, partsToJson } from './conversation/blob-store';

assertDefined(env.WORKSPACE_BUCKET, 'WORKSPACE_BUCKET binding required');
const bucket = env.WORKSPACE_BUCKET;

async function clearBlobs(): Promise<void> {
	const list = await bucket.list({ prefix: 'blobs/' });
	for (const obj of list.objects) await bucket.delete(obj.key);
}

beforeEach(clearBlobs);
afterEach(async () => {
	await clearBlobs();
	await env.DB.prepare('DELETE FROM conversations').run();
});

// 3 MB worth of base64 chars. A row carrying this inline would exceed
// SQLite's 2 MB per-value cap when wrapped in the parts JSON envelope.
function bigImageBase64(): string {
	const target = 3 * 1024 * 1024;
	let s = '';
	while (s.length < target) s += 'AAAA';
	return s.slice(0, target);
}

describe('ConversationDurableObject — large blob persistence', () => {
	it('persists an assistant message with a multi-MB image without hitting SQLITE_TOOBIG', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const big = bigImageBase64();
		const parts: MessagePart[] = [
			{ text: 'here is the image', type: 'text' },
			{
				content: [
					{ text: 'Loaded photo.png.', type: 'text' },
					{ data: big, mimeType: 'image/png', type: 'image' },
				],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const partsJson = await partsToJson(parts, env);
		// Sanity: the persisted JSON is now small even though the image is huge.
		assertDefined(partsJson);
		expect(partsJson.length).toBeLessThan(64 * 1024);

		// The actual write that used to fail with `string or blob too big:
		// SQLITE_TOOBIG` is the UPDATE the DO issues at end-of-turn.
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				`INSERT INTO messages (id, role, content, model, status, created_at, parts)
				 VALUES ('a-big', 'assistant', '', 'm', 'complete', 1, ?)`,
				partsJson,
			);
		});

		const state = await readState(stub);
		const msg = state.messages.find((m) => m.id === 'a-big');
		expect(msg).toBeTruthy();
		assertDefined(msg);
		assertDefined(msg.parts);
		const tr = msg.parts.find((p) => p.type === 'tool_result');
		if (!tr || tr.type !== 'tool_result' || typeof tr.content === 'string') throw new Error('shape');
		const img = tr.content.find((b) => b.type === 'image');
		if (!img || img.type !== 'image') throw new Error('shape');
		// Read path inlines the bytes back, so callers see the original shape.
		expect(img.data).toBe(big);
	});

	it('a write that bypasses offloading (legacy inline) still succeeds for small images', async () => {
		// Belt-and-suspenders: the offload threshold is 256 KB; a 1 KB image
		// stays inline. The persisted JSON carries the full bytes and the
		// read path returns them unchanged.
		const small = 'AAAA'.repeat(256); // ~1 KB
		const parts: MessagePart[] = [
			{
				content: [{ data: small, mimeType: 'image/png', type: 'image' }],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const json = await partsToJson(parts, env);
		expect(json).not.toContain('r2-blob:');
		const restored = await partsFromJson(json, env);
		expect(restored).toEqual(parts);
		const list = await bucket.list({ prefix: 'blobs/' });
		expect(list.objects).toHaveLength(0);
	});
});
