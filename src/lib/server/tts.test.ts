import { describe, expect, it } from 'vitest';
import { DEFAULT_TTS_VOICE, extractSpeakableText, isValidTtsVoice, splitForTts, TTS_VOICES } from './tts';
import type { MessagePart } from '$lib/types/conversation';

describe('extractSpeakableText', () => {
	it('falls back to plain content when parts is undefined', () => {
		expect(extractSpeakableText({ content: 'Hello world.', parts: undefined })).toBe('Hello world.');
	});

	it('joins only text and info parts, skipping thinking and tool blocks', () => {
		const parts: MessagePart[] = [
			{ type: 'thinking', text: 'internal monologue' },
			{ type: 'text', text: 'First line.' },
			{ type: 'tool_use', id: 't1', name: 'web_search', input: {} },
			{ type: 'tool_result', toolUseId: 't1', content: 'big blob', isError: false },
			{ type: 'text', text: 'Second line.' },
			{ type: 'citations', citations: [{ url: 'https://example.com', title: 'ex' }] },
			{ type: 'info', text: 'note' },
		];
		const got = extractSpeakableText({ content: '', parts });
		expect(got).toContain('First line.');
		expect(got).toContain('Second line.');
		expect(got).toContain('note');
		expect(got).not.toContain('internal monologue');
		expect(got).not.toContain('big blob');
	});

	it('strips fenced code blocks entirely', () => {
		const md = 'Look at this:\n\n```js\nconsole.log("noisy")\n```\n\nDone.';
		const got = extractSpeakableText({ content: md, parts: undefined });
		expect(got).not.toContain('console.log');
		expect(got).toContain('Look at this');
		expect(got).toContain('Done.');
	});

	it('collapses markdown links to their label', () => {
		const got = extractSpeakableText({
			content: 'See [the docs](https://example.com/docs) please.',
			parts: undefined,
		});
		expect(got).toBe('See the docs please.');
	});

	it('drops bold/italic markers but keeps the words', () => {
		const got = extractSpeakableText({
			content: 'This is **bold** and *italic*.',
			parts: undefined,
		});
		expect(got).toBe('This is bold and italic.');
	});

	it('truncates output past the hard cap and appends [truncated]', () => {
		const long = 'a'.repeat(60_000);
		const got = extractSpeakableText({ content: long, parts: undefined });
		expect(got.length).toBeLessThanOrEqual(50_000 + ' [truncated]'.length);
		expect(got.endsWith('[truncated]')).toBe(true);
	});

	it('returns empty string when there are no speakable parts and no content', () => {
		const parts: MessagePart[] = [
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
		];
		expect(extractSpeakableText({ content: '', parts })).toBe('');
	});
});

describe('splitForTts', () => {
	it('returns the input unchanged when it fits in one chunk', () => {
		const got = splitForTts('Short.', 1900);
		expect(got).toEqual(['Short.']);
	});

	it('keeps every chunk under the cap', () => {
		const text = ('Sentence one. Sentence two? Sentence three! ' + 'word '.repeat(500)).trim();
		const got = splitForTts(text, 200);
		expect(got.length).toBeGreaterThan(1);
		for (const c of got) expect(c.length).toBeLessThanOrEqual(200);
	});

	it('prefers sentence terminators when splitting', () => {
		// Build text with a clear sentence boundary near the cap.
		const a = 'a'.repeat(150) + '. ';
		const b = 'b'.repeat(150) + '. ';
		const got = splitForTts(a + b, 200);
		expect(got[0].endsWith('.')).toBe(true);
		// Regression: the first chunk shouldn't contain any of the second
		// sentence's `b` characters — that would mean we cut mid-sentence
		// when a clean boundary was available.
		expect(got[0]).not.toContain('b');
	});

	it('preserves the entire input across chunks', () => {
		const text = 'one two three four five six seven eight nine ten '.repeat(40).trim();
		const got = splitForTts(text, 100);
		expect(got.join(' ').replace(/\s+/g, ' ')).toBe(text);
	});

	it('falls back to a hard cut when no whitespace exists', () => {
		const text = 'x'.repeat(500);
		const got = splitForTts(text, 100);
		expect(got.length).toBeGreaterThanOrEqual(5);
		for (const c of got) expect(c.length).toBeLessThanOrEqual(100);
	});
});

describe('TTS voice list', () => {
	it('includes the default voice', () => {
		expect(isValidTtsVoice(DEFAULT_TTS_VOICE)).toBe(true);
	});

	it('rejects unknown voices', () => {
		expect(isValidTtsVoice('not-a-voice')).toBe(false);
	});

	it('exposes a non-empty allowed list', () => {
		expect(TTS_VOICES.length).toBeGreaterThan(0);
	});
});
