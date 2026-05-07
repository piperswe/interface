import { error, json } from '@sveltejs/kit';
import { Buffer } from 'node:buffer';
import type { RequestHandler } from './$types';

// Whisper-large-v3-turbo accepts audio up to ~25 MB. Cap at the same number
// to surface a clean 413 instead of a Workers AI failure.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

type WhisperResponse = { text?: string };

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const ai = platform.env.AI;
	if (!ai) error(503, 'Workers AI binding not configured');

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

	let result: WhisperResponse;
	try {
		result = (await ai.run(WHISPER_MODEL, { audio: base64 })) as WhisperResponse;
	} catch (err) {
		error(502, err instanceof Error ? err.message : String(err));
	}

	return json({ text: result.text ?? '' });
};
