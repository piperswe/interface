import { error, json } from '@sveltejs/kit';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { validateOrThrow } from '$lib/zod-utils';
import type { RequestHandler } from './$types';

// Whisper-large-v3-turbo accepts audio up to ~25 MB. Cap at the same number
// to surface a clean 413 instead of a Workers AI failure.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

const whisperResponseSchema = z.object({ text: z.string().optional() }).passthrough();

export const POST: RequestHandler = async ({ request, platform, url }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const ai = platform.env.AI;
	if (!ai) error(503, 'Workers AI binding not configured');

	// CSRF: SvelteKit's built-in protection only runs for form submissions,
	// but this endpoint accepts a raw `audio/*` body. Require the Origin
	// header to match the request URL so a cross-origin page can't burn
	// Workers AI budget by silently POSTing audio.
	const origin = request.headers.get('origin');
	if (origin && origin !== url.origin) {
		error(403, 'cross-origin request');
	}

	const contentLengthHeader = request.headers.get('content-length');
	const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : NaN;
	if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
		error(413, `audio too large (max ${MAX_AUDIO_BYTES} bytes)`);
	}

	if (!request.body) error(400, 'request body required');

	const buf = await request.arrayBuffer();
	if (buf.byteLength === 0) error(400, 'empty audio body');
	if (buf.byteLength > MAX_AUDIO_BYTES) {
		error(413, `audio too large (max ${MAX_AUDIO_BYTES} bytes)`);
	}

	const base64 = Buffer.from(buf).toString('base64');

	let result: z.infer<typeof whisperResponseSchema>;
	try {
		result = validateOrThrow(
			whisperResponseSchema,
			await ai.run(WHISPER_MODEL, { audio: base64 }),
			'Workers AI whisper response',
		);
	} catch (err) {
		// Don't echo the raw upstream error verbatim — Workers AI error bodies
		// can include configuration details the operator may not want to leak.
		const summary = err instanceof Error ? err.name : 'upstream error';
		console.error('transcribe error', err);
		error(502, summary);
	}

	return json({ text: result.text ?? '' });
};
