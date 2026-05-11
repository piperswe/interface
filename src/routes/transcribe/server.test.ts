import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

interface CallOpts {
	body?: BodyInit | null;
	contentType?: string;
	contentLength?: number | string;
	omitContentLength?: boolean;
	origin?: string;
	ai?: { run: (...args: unknown[]) => unknown } | null;
}

async function callPost(options: CallOpts = {}): Promise<Response> {
	const url = new URL('http://localhost/transcribe');
	const headers = new Headers();
	if (options.contentType) headers.set('content-type', options.contentType);
	if (options.origin) headers.set('origin', options.origin);
	const body = options.body ?? new Uint8Array(4);
	if (options.contentLength != null) {
		headers.set('content-length', String(options.contentLength));
	} else if (!options.omitContentLength) {
		if (typeof body === 'string') {
			headers.set('content-length', String(new TextEncoder().encode(body).byteLength));
		} else if (body instanceof Uint8Array) {
			headers.set('content-length', String(body.byteLength));
		}
	}
	const request = new Request(url.toString(), { method: 'POST', headers, body });
	// `wrangler.test.jsonc` doesn't bind Workers AI (it's a remote service),
	// so synthesise a `platform.env` whose AI binding either passes the
	// `if (!ai)` guard with a stub, or omits the binding when the test wants
	// to exercise that branch. Tests below don't reach `ai.run` because the
	// 411 / 400 / 413 / 403 branches all return before it.
	const ai = options.ai === null ? undefined : (options.ai ?? { run: vi.fn() });
	const event = {
		url,
		platform: { env: { AI: ai } },
		request,
	} as unknown as Parameters<typeof POST>[0];
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

describe('transcribe +server.ts — POST', () => {
	// Regression: the previous guard read `parseInt(null, 10) === NaN` when
	// the header was absent and then `Number.isFinite(NaN) === false`, so the
	// size cap was a no-op for any request that didn't send `Content-Length`.
	// `request.arrayBuffer()` would buffer the full body before the post-read
	// check fired. Match the sandbox upload endpoint and require the header.
	it('rejects requests missing Content-Length with 411', async () => {
		await expectError(callPost({ omitContentLength: true }), 411);
	});

	it('rejects non-numeric Content-Length with 400', async () => {
		await expectError(callPost({ contentLength: '12abc' }), 400);
	});

	it('rejects oversized Content-Length with 413', async () => {
		// 25 MB + 1; advertised size, body itself irrelevant for this branch.
		await expectError(callPost({ contentLength: 25 * 1024 * 1024 + 1 }), 413);
	});

	// Regression (companion to the same-origin enforcement): a request whose
	// Origin doesn't match the request URL must be rejected before any size
	// check or AI invocation, otherwise a cross-origin page can burn Workers
	// AI budget.
	it('rejects cross-origin requests with 403', async () => {
		const aiRun = vi.fn();
		await expectError(callPost({ origin: 'https://evil.example', ai: { run: aiRun } }), 403);
		expect(aiRun).not.toHaveBeenCalled();
	});

	it('returns 503 when the AI binding is missing', async () => {
		await expectError(callPost({ ai: null }), 503);
	});
});
