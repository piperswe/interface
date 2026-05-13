// Server-only helpers for text-to-speech via Workers AI (`@cf/deepgram/aura-2-en`).
//
// `extractSpeakableText` walks a message's parts and yields a clean prose
// string suitable for TTS — skipping thinking, tool calls, and tool results,
// and stripping markdown structure that would otherwise be vocalised as
// punctuation noise. `synthesizeSpeech` chunks the input on sentence
// boundaries (Aura caps each request at 2000 chars) and concatenates the
// resulting MP3 streams — MP3 frames are self-contained, so byte-level
// concatenation produces a valid stream.

import type { MessagePart, MessageRow } from '$lib/types/conversation';

export const TTS_VOICES = [
	'amalthea',
	'andromeda',
	'apollo',
	'arcas',
	'aries',
	'asteria',
	'athena',
	'atlas',
	'aurora',
	'callista',
	'cora',
	'cordelia',
	'delia',
	'draco',
	'electra',
	'harmonia',
	'helena',
	'hera',
	'hermes',
	'hyperion',
	'iris',
	'janus',
	'juno',
	'jupiter',
	'luna',
	'mars',
	'minerva',
	'neptune',
	'odysseus',
	'ophelia',
	'orion',
	'orpheus',
	'pandora',
	'phoebe',
	'pluto',
	'saturn',
	'thalia',
	'theia',
	'vesta',
	'zeus',
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const DEFAULT_TTS_VOICE: TtsVoice = 'asteria';

export function isValidTtsVoice(v: string): v is TtsVoice {
	return (TTS_VOICES as readonly string[]).includes(v);
}

// Aura caps each request at 2000 characters. Stay under that with a small
// margin so a sentence-boundary cut never overshoots.
const TTS_CHUNK_CHARS = 1900;
// Hard upper bound on the total spoken text. Past this we truncate to keep
// latency and cost bounded — a 50k-char essay is not what the button is for.
const MAX_TTS_CHARS = 50_000;

function stripMarkdown(s: string): string {
	return (
		s
			// Fenced code blocks: drop entirely (reading source aloud is useless).
			.replace(/```[\s\S]*?```/g, ' ')
			// Inline code: keep contents, drop backticks.
			.replace(/`([^`]+)`/g, '$1')
			// Images: drop the syntax, keep alt text.
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
			// Links: collapse `[label](url)` to `label`.
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			// Bold/italic markers.
			.replace(/(\*\*|__)(.*?)\1/g, '$2')
			.replace(/(\*|_)(.*?)\1/g, '$2')
			// Headings: drop leading hashes.
			.replace(/^#{1,6}\s+/gm, '')
			// Blockquote markers.
			.replace(/^>\s?/gm, '')
			// Horizontal rules.
			.replace(/^[-*_]{3,}\s*$/gm, ' ')
			// Collapse runs of whitespace.
			.replace(/\s+/g, ' ')
			.trim()
	);
}

function partText(p: MessagePart): string {
	if (p.type === 'text') return p.text;
	if (p.type === 'info') return p.text;
	return '';
}

export function extractSpeakableText(message: Pick<MessageRow, 'content' | 'parts'>): string {
	const parts = message.parts;
	const raw = parts && parts.length > 0 ? parts.map(partText).filter(Boolean).join('\n\n') : (message.content ?? '');
	const stripped = stripMarkdown(raw);
	if (stripped.length <= MAX_TTS_CHARS) return stripped;
	return `${stripped.slice(0, MAX_TTS_CHARS).trimEnd()} [truncated]`;
}

// Split text into chunks that fit Aura's 2000-char per-request cap. Prefers
// sentence boundaries; falls back to the last whitespace, then a hard cut.
export function splitForTts(text: string, maxChunk: number = TTS_CHUNK_CHARS): string[] {
	const chunks: string[] = [];
	let remaining = text.trim();
	while (remaining.length > maxChunk) {
		const window = remaining.slice(0, maxChunk);
		// Prefer a sentence terminator close to the end of the window. Look
		// only in the back half so we don't make tiny chunks for short
		// sentences early in the text.
		const halfway = Math.floor(maxChunk / 2);
		let cut = -1;
		for (const re of [/[.!?][\s)\]"']/g, /[,;:][\s)\]"']/g, /\s/g]) {
			let last = -1;
			re.lastIndex = halfway;
			while (true) {
				const m = re.exec(window);
				if (m === null) break;
				last = m.index + 1;
			}
			if (last > halfway) {
				cut = last;
				break;
			}
		}
		if (cut <= 0) cut = maxChunk;
		const piece = remaining.slice(0, cut).trim();
		if (piece) chunks.push(piece);
		remaining = remaining.slice(cut).trim();
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

async function runChunk(ai: Ai, chunk: string, voice: TtsVoice): Promise<Response> {
	// Aura rejects `container` with `encoding=mp3` (no outer container);
	// pass only the encoding.
	return ai.run('@cf/deepgram/aura-2-en', { encoding: 'mp3', speaker: voice, text: chunk }, { returnRawResponse: true });
}

async function pipeBody(body: ReadableStream<Uint8Array>, controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		if (value) controller.enqueue(value);
	}
}

// Hits Workers AI and returns a streaming Response so the browser can start
// playing the first chunk's MP3 frames before the later chunks finish
// synthesising. The first chunk is awaited eagerly so an upstream HTTP error
// surfaces as a real status code (502 from the caller) before any bytes hit
// the wire; subsequent chunks pipe lazily through the body stream.
export async function synthesizeSpeech(env: Env, text: string, voice: TtsVoice): Promise<Response> {
	const ai = (env as unknown as { AI: Ai }).AI;
	if (!ai) throw new Error('Workers AI binding (env.AI) not configured');
	const chunks = splitForTts(text);
	if (chunks.length === 0) throw new Error('no text to synthesise');

	const first = await runChunk(ai, chunks[0], voice);
	if (!first.ok || !first.body) {
		const detail = await first.text().catch(() => '');
		throw new Error(`TTS upstream ${first.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
	}
	const firstBody = first.body;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				await pipeBody(firstBody, controller);
				for (let i = 1; i < chunks.length; i++) {
					const res = await runChunk(ai, chunks[i], voice);
					if (!res.ok || !res.body) {
						const detail = await res.text().catch(() => '');
						throw new Error(`TTS upstream ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
					}
					await pipeBody(res.body, controller);
				}
				controller.close();
			} catch (err) {
				controller.error(err);
			}
		},
	});
	return new Response(stream, { headers: { 'Content-Type': 'audio/mpeg' } });
}
