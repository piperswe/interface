import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

type Platform = NonNullable<Parameters<typeof POST>[0]['platform']>;

async function callPost(opts: {
	body?: BodyInit | null;
	contentType?: string;
	contentLength?: number;
	platform?: Platform;
}): Promise<Response> {
	const url = new URL('http://localhost/transcribe');
	const headers = new Headers();
	if (opts.contentType) headers.set('content-type', opts.contentType);
	if (opts.contentLength != null) headers.set('content-length', String(opts.contentLength));
	const request = new Request(url.toString(), {
		method: 'POST',
		headers,
		body: opts.body ?? null,
	});
	const event = {
		params: {},
		url,
		platform: opts.platform,
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

function makePlatform(aiRun: (model: string, input: unknown) => unknown): Platform {
	return {
		env: { AI: { run: aiRun } },
	} as unknown as Platform;
}

describe('transcribe +server.ts — POST', () => {
	it('returns 500 when platform is missing', async () => {
		await expectError(
			callPost({ body: new Uint8Array([1, 2, 3]), contentType: 'audio/webm' }),
			500,
		);
	});

	it('returns 503 when the AI binding is missing', async () => {
		await expectError(
			callPost({
				body: new Uint8Array([1, 2, 3]),
				contentType: 'audio/webm',
				platform: { env: {} } as unknown as Platform,
			}),
			503,
		);
	});

	it('rejects oversize bodies via Content-Length with 413', async () => {
		const aiRun = vi.fn();
		await expectError(
			callPost({
				body: new Uint8Array([1]),
				contentType: 'audio/webm',
				contentLength: 100 * 1024 * 1024,
				platform: makePlatform(aiRun),
			}),
			413,
		);
		expect(aiRun).not.toHaveBeenCalled();
	});

	it('rejects empty bodies with 400', async () => {
		await expectError(
			callPost({
				body: new Uint8Array(),
				contentType: 'audio/webm',
				platform: makePlatform(() => ({ text: 'unused' })),
			}),
			400,
		);
	});

	it('forwards audio bytes as base64 to the Whisper model and returns its text', async () => {
		const aiRun = vi.fn().mockResolvedValue({ text: '  hello world  ' });
		const audio = new Uint8Array([1, 2, 3, 4, 5]);
		const res = await callPost({
			body: audio,
			contentType: 'audio/webm',
			platform: makePlatform(aiRun),
		});
		expect(res.ok).toBe(true);
		expect(await res.json()).toEqual({ text: '  hello world  ' });
		expect(aiRun).toHaveBeenCalledTimes(1);
		const [model, input] = aiRun.mock.calls[0];
		expect(model).toBe('@cf/openai/whisper-large-v3-turbo');
		// Decoding base64 should round-trip the original bytes.
		const decoded = Uint8Array.from(atob((input as { audio: string }).audio), (c) =>
			c.charCodeAt(0),
		);
		expect(Array.from(decoded)).toEqual([1, 2, 3, 4, 5]);
	});

	it('returns 502 when the AI binding throws', async () => {
		const aiRun = vi.fn().mockRejectedValue(new Error('upstream boom'));
		await expectError(
			callPost({
				body: new Uint8Array([1, 2]),
				contentType: 'audio/webm',
				platform: makePlatform(aiRun),
			}),
			502,
		);
	});

	it('defaults to empty string when the model omits text', async () => {
		const aiRun = vi.fn().mockResolvedValue({});
		const res = await callPost({
			body: new Uint8Array([9]),
			contentType: 'audio/webm',
			platform: makePlatform(aiRun),
		});
		expect(await res.json()).toEqual({ text: '' });
	});
});
