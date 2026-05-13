// Offload large in-memory blobs (currently: tool_result image bytes) to R2
// before persisting to the DO's SQLite store, and resolve them back on read.
//
// Why: SQLite's per-value limit is ~2 MB. A single tool_result that includes
// a base64-encoded image is enough to push the `parts` JSON over that cap,
// causing `string or blob too big: SQLITE_TOOBIG` and breaking the
// conversation. By extracting the bytes to R2 and replacing the inline
// base64 with a `r2-blob:<sha256>` sentinel, the persisted JSON stays small
// regardless of how many images flow through the conversation.
//
// On read, sentinels are resolved transparently: callers continue to see
// `data: <base64>` so existing serialization (LLM history, client wire
// format, tests) doesn't have to change.
//
// Storage layout:
//   - Bucket: WORKSPACE_BUCKET (already bound; lives next to per-conversation
//     workspace files but in a top-level `blobs/` prefix so dedupe spans
//     conversations).
//   - Key:    `blobs/<sha256-hex>`
//   - Value:  raw image bytes (not base64).
//
// Trade-off: dedupe is content-addressed — two messages with identical image
// bytes share one R2 object. We never delete blobs (a conversation hard
// delete only drops its DO + D1 row; orphaned blobs persist). For the
// immediate fix that's acceptable; a sweeper can come later.

import { z } from 'zod';
import type { MessagePart, ToolResultBlock } from '$lib/types/conversation';
import { parseJsonWith } from '$lib/zod-utils';

// `parts` is a structurally complex discriminated union; rather than mirror
// the full type tree, we only verify the on-disk JSON parses to an array of
// `{ type: string, ... }` records. A corrupted row therefore yields `null`
// instead of crashing downstream consumers that destructure on `type`.
const partsArrayShapeSchema = z.array(z.object({ type: z.string() }).passthrough());

const BLOB_KEY_PREFIX = 'blobs/';
const BLOB_SENTINEL_PREFIX = 'r2-blob:';
// 256 KB is well below SQLite's 2 MB per-value limit, leaves room for many
// inline-encoded blocks per parts JSON, and keeps small thumbnails inline so
// the common path doesn't pay the R2 round-trip.
const OFFLOAD_THRESHOLD_BYTES = 256 * 1024;

export type BlobEnv = { WORKSPACE_BUCKET?: R2Bucket };

export function isBlobSentinel(s: string): boolean {
	return s.startsWith(BLOB_SENTINEL_PREFIX);
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function bytesToBase64(bytes: Uint8Array): string {
	let s = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
	}
	return btoa(s);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// Pass `.buffer` to satisfy the BufferSource overload that's pickier about
	// the underlying ArrayBuffer type than `Uint8Array` itself.
	const buf = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
	const view = new Uint8Array(buf);
	let out = '';
	for (let i = 0; i < view.length; i++) {
		out += view[i].toString(16).padStart(2, '0');
	}
	return out;
}

// Walk parts and return a deep-ish copy where every image block whose `data`
// is large enough (and not already a sentinel) has been uploaded to R2 and
// replaced with `r2-blob:<sha256>`. The input is never mutated.
//
// `uploadedHashes`, when supplied, is consulted (and updated) so repeat
// serializations of the same parts array — e.g. the debounced flush firing
// every 500 ms during a long stream — don't re-upload blobs the DO has
// already pushed in this activation.
export async function offloadLargeBlobs(parts: MessagePart[], env: BlobEnv, uploadedHashes?: Set<string>): Promise<MessagePart[]> {
	const bucket = env.WORKSPACE_BUCKET;
	// Without a bucket binding we can't offload; fall back to the legacy
	// inline behavior. Caller is responsible for catching the resulting
	// SQLITE_TOOBIG if the row still won't fit.
	if (!bucket) return parts;

	let out: MessagePart[] | null = null;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p.type !== 'tool_result' || typeof p.content === 'string') {
			if (out) out.push(p);
			continue;
		}
		const newContent = await maybeOffloadBlocks(p.content, bucket, uploadedHashes);
		if (newContent === p.content) {
			if (out) out.push(p);
			continue;
		}
		if (!out) out = parts.slice(0, i);
		out.push({ ...p, content: newContent });
	}
	return out ?? parts;
}

async function maybeOffloadBlocks(
	blocks: ToolResultBlock[],
	bucket: R2Bucket,
	uploadedHashes: Set<string> | undefined,
): Promise<ToolResultBlock[]> {
	let mutated = false;
	const next: ToolResultBlock[] = [];
	for (const block of blocks) {
		if (block.type !== 'image' || isBlobSentinel(block.data) || block.data.length < OFFLOAD_THRESHOLD_BYTES) {
			next.push(block);
			continue;
		}
		const bytes = base64ToBytes(block.data);
		const hash = await sha256Hex(bytes);
		const key = `${BLOB_KEY_PREFIX}${hash}`;
		if (!uploadedHashes?.has(hash)) {
			// head() short-circuits the put when the blob already exists from
			// a prior DO activation or another conversation. R2 puts are
			// idempotent on the same key/value so this is mostly a bandwidth
			// optimization.
			const existing = await bucket.head(key);
			if (!existing) {
				await bucket.put(key, bytes, {
					httpMetadata: { contentType: block.mimeType },
				});
			}
			uploadedHashes?.add(hash);
		}
		next.push({ ...block, data: `${BLOB_SENTINEL_PREFIX}${hash}` });
		mutated = true;
	}
	return mutated ? next : blocks;
}

// Reverse of `offloadLargeBlobs`. Walk parts, fetch any sentineled image
// blocks from R2, and re-inline as base64 so callers see the original shape.
//
// A missing blob (e.g. R2 lifecycle deleted it, or a dev environment without
// the bucket bound) becomes an empty-data image block — the renderer shows a
// broken image rather than crashing the page or refusing to load history.
export async function resolveBlobRefs(parts: MessagePart[], env: BlobEnv): Promise<MessagePart[]> {
	const bucket = env.WORKSPACE_BUCKET;
	let out: MessagePart[] | null = null;
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p.type !== 'tool_result' || typeof p.content === 'string') {
			if (out) out.push(p);
			continue;
		}
		const needsResolve = p.content.some((b) => b.type === 'image' && isBlobSentinel(b.data));
		if (!needsResolve) {
			if (out) out.push(p);
			continue;
		}
		const newContent = await Promise.all(p.content.map((b) => resolveBlock(b, bucket)));
		if (!out) out = parts.slice(0, i);
		out.push({ ...p, content: newContent });
	}
	return out ?? parts;
}

async function resolveBlock(block: ToolResultBlock, bucket: R2Bucket | undefined): Promise<ToolResultBlock> {
	if (block.type !== 'image' || !isBlobSentinel(block.data)) return block;
	if (!bucket) return { ...block, data: '' };
	const hash = block.data.slice(BLOB_SENTINEL_PREFIX.length);
	const obj = await bucket.get(`${BLOB_KEY_PREFIX}${hash}`);
	if (!obj) return { ...block, data: '' };
	const bytes = new Uint8Array(await obj.arrayBuffer());
	return { ...block, data: bytesToBase64(bytes) };
}

// Convenience wrapper used by every read site: parse the `parts` JSON column
// and resolve any blob references in one call.
export async function partsFromJson(json: string | null, env: BlobEnv): Promise<MessagePart[] | null> {
	if (!json) return null;
	const parsed = parseJsonWith(partsArrayShapeSchema, json);
	if (!parsed) return null;
	return resolveBlobRefs(parsed as MessagePart[], env);
}

// Convenience wrapper used by every write site: offload large blobs and
// stringify in one call. Returns `null` for an empty array so callers can
// pass the result straight to a SQL parameter.
export async function partsToJson(parts: MessagePart[], env: BlobEnv, uploadedHashes?: Set<string>): Promise<string | null> {
	if (parts.length === 0) return null;
	const offloaded = await offloadLargeBlobs(parts, env, uploadedHashes);
	return JSON.stringify(offloaded);
}
