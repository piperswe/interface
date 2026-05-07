// Server-only helpers for text-to-speech via Workers AI (`@cf/deepgram/aura-2-en`).
//
// `extractSpeakableText` walks a message's parts and yields a clean prose
// string suitable for TTS — skipping thinking, tool calls, and tool results,
// and stripping markdown structure that would otherwise be vocalised as
// punctuation noise. `synthesizeSpeech` calls the Workers AI binding and
// returns the raw audio Response so callers can stream it through.

import type { MessagePart, MessageRow } from '$lib/types/conversation';

export const TTS_VOICES = [
	'amalthea', 'andromeda', 'apollo', 'arcas', 'aries', 'asteria', 'athena',
	'atlas', 'aurora', 'callista', 'cora', 'cordelia', 'delia', 'draco',
	'electra', 'harmonia', 'helena', 'hera', 'hermes', 'hyperion', 'iris',
	'janus', 'juno', 'jupiter', 'luna', 'mars', 'minerva', 'neptune',
	'odysseus', 'ophelia', 'orion', 'orpheus', 'pandora', 'phoebe', 'pluto',
	'saturn', 'thalia', 'theia', 'vesta', 'zeus',
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const DEFAULT_TTS_VOICE: TtsVoice = 'asteria';

export function isValidTtsVoice(v: string): v is TtsVoice {
	return (TTS_VOICES as readonly string[]).includes(v);
}

const MAX_TTS_CHARS = 3000;

function stripMarkdown(s: string): string {
	return s
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
		.trim();
}

function partText(p: MessagePart): string {
	if (p.type === 'text') return p.text;
	if (p.type === 'info') return p.text;
	return '';
}

export function extractSpeakableText(message: Pick<MessageRow, 'content' | 'parts'>): string {
	const parts = message.parts;
	const raw = parts && parts.length > 0
		? parts.map(partText).filter(Boolean).join('\n\n')
		: (message.content ?? '');
	const stripped = stripMarkdown(raw);
	if (stripped.length <= MAX_TTS_CHARS) return stripped;
	return stripped.slice(0, MAX_TTS_CHARS).trimEnd() + ' [truncated]';
}

// Hits Workers AI and returns the raw audio Response. Encoding defaults to
// MP3 with no container so we can stream straight to the browser's <audio>.
export async function synthesizeSpeech(
	env: Env,
	text: string,
	voice: TtsVoice,
): Promise<Response> {
	const ai = (env as unknown as { AI: Ai }).AI;
	if (!ai) throw new Error('Workers AI binding (env.AI) not configured');
	// Aura rejects `container` when `encoding=mp3` (the MP3 stream has no
	// outer container). Pass only the encoding and let the model use its
	// default sample/bit rate.
	return ai.run(
		'@cf/deepgram/aura-2-en',
		{ text, speaker: voice, encoding: 'mp3' },
		{ returnRawResponse: true },
	);
}
