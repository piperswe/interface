import { describe, expect, it } from 'vitest';
import type { MessagePart } from '$lib/types/conversation';
import { assertDefined } from '../../../../../test/assert-defined';
import { dedupeCitationsByUrl, normalizeParts, partsToMessages, trimTrailingPartialOutput } from './parts';

describe('dedupeCitationsByUrl', () => {
	it('preserves first-occurrence order and drops later duplicates', () => {
		const out = dedupeCitationsByUrl([
			{ title: 'A', url: 'https://a' },
			{ title: 'B', url: 'https://b' },
			{ title: 'A again', url: 'https://a' },
			{ title: 'C', url: 'https://c' },
			{ title: 'B again', url: 'https://b' },
		]);
		expect(out.map((c) => c.url)).toEqual(['https://a', 'https://b', 'https://c']);
		// First-seen wins, so the duplicate's title is discarded.
		expect(out[0].title).toBe('A');
		expect(out[1].title).toBe('B');
	});
	it('returns an empty array when given empty input', () => {
		expect(dedupeCitationsByUrl([])).toEqual([]);
	});
});

describe('partsToMessages', () => {
	// Regression: `citations` is a UI-only part (added in the bugfix that
	// made citations renderable). It must be skipped when reconstructing
	// the LLM history, just like `info`. If it ever leaks through, the
	// LLM API will reject the message because the schema has no
	// `citations` block.
	it('skips citations parts when building LLM history', () => {
		const parts: MessagePart[] = [
			{ text: 'here it is', type: 'text' },
			{ citations: [{ title: 'Example', url: 'https://example.com' }], type: 'citations' },
		];
		const msgs = partsToMessages(parts);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe('assistant');
		const blocks = msgs[0].content as Array<{ type: string }>;
		expect(blocks.map((b) => b.type)).toEqual(['text']);
	});

	it('skips info parts when building LLM history', () => {
		const parts: MessagePart[] = [
			{ text: 'answer', type: 'text' },
			{ text: 'context compacted', type: 'info' },
		];
		const msgs = partsToMessages(parts);
		expect(msgs).toHaveLength(1);
		const blocks = msgs[0].content as Array<{ type: string }>;
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('text');
	});

	it('splits assistant tool_use and tool_result into alternating roles', () => {
		const parts: MessagePart[] = [
			{ text: 'thinking out loud', type: 'text' },
			{ id: 't1', input: { q: 'x' }, name: 'search', type: 'tool_use' },
			{ content: 'hit', isError: false, toolUseId: 't1', type: 'tool_result' },
			{ text: 'final', type: 'text' },
		];
		const msgs = partsToMessages(parts);
		expect(msgs.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
	});

	it('round-trips ThinkingPart.signature so Anthropic accepts the next turn', () => {
		// Regression: signatures used to be discarded in `partsToMessages`,
		// so a stored Anthropic thinking block emerged with `signature: ''`
		// and Anthropic 400'd the next turn.
		const parts: MessagePart[] = [
			{ signature: 'auth-blob-abc', text: 'planning', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ content: 'ok', isError: false, toolUseId: 't1', type: 'tool_result' },
		];
		const msgs = partsToMessages(parts);
		const asst = msgs[0];
		expect(asst.role).toBe('assistant');
		const thinkingBlock = (asst.content as Array<Record<string, unknown>>).find((b) => b.type === 'thinking');
		expect(thinkingBlock?.signature).toBe('auth-blob-abc');
	});

	it('omits the signature field when ThinkingPart has none (signature-less legacy rows)', () => {
		const parts: MessagePart[] = [
			{ text: 'planning', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ content: 'ok', isError: false, toolUseId: 't1', type: 'tool_result' },
		];
		const msgs = partsToMessages(parts);
		const thinkingBlock = (msgs[0].content as Array<Record<string, unknown>>).find((b) => b.type === 'thinking');
		expect(thinkingBlock).toBeDefined();
		assertDefined(thinkingBlock);
		expect('signature' in thinkingBlock).toBe(false);
	});

	it('preserves array tool_result content (text + image) so sandbox_load_image survives replay', () => {
		const parts: MessagePart[] = [
			{ id: 't1', input: { path: '/workspace/x.png' }, name: 'sandbox_load_image', type: 'tool_use' },
			{
				content: [
					{ text: 'Loaded x.png.', type: 'text' },
					{ data: 'AAAA', mimeType: 'image/png', type: 'image' },
				],
				isError: false,
				toolUseId: 't1',
				type: 'tool_result',
			},
		];
		const msgs = partsToMessages(parts);
		expect(msgs).toHaveLength(2);
		const toolBlock = (msgs[1].content as Array<{ type: string }>)[0] as {
			type: 'tool_result';
			content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
		};
		expect(toolBlock.type).toBe('tool_result');
		expect(Array.isArray(toolBlock.content)).toBe(true);
		expect(toolBlock.content).toContainEqual({ text: 'Loaded x.png.', type: 'text' });
		expect(toolBlock.content).toContainEqual({ data: 'AAAA', mimeType: 'image/png', type: 'image' });
	});
});

describe('trimTrailingPartialOutput', () => {
	it('trims trailing text/thinking parts past the last tool boundary', () => {
		const parts: MessagePart[] = [
			{ text: 'one', type: 'text' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ content: 'r', isError: false, toolUseId: 't1', type: 'tool_result' },
			{ text: 'partial', type: 'text' },
		];
		const out = trimTrailingPartialOutput(parts);
		expect(out.map((p) => p.type)).toEqual(['text', 'tool_use', 'tool_result']);
	});
	it('keeps everything when no trailing partial output exists', () => {
		const parts: MessagePart[] = [
			{ text: 'a', type: 'text' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ content: 'r', isError: false, toolUseId: 't1', type: 'tool_result' },
		];
		const out = trimTrailingPartialOutput(parts);
		expect(out).toEqual(parts);
	});
});

describe('normalizeParts', () => {
	it('appends synthetic error tool_results for unmatched tool_use', () => {
		const parts: MessagePart[] = [{ id: 't1', input: {}, name: 'x', type: 'tool_use' }];
		normalizeParts(parts, 'aborted');
		expect(parts).toHaveLength(2);
		const r = parts[1];
		expect(r.type).toBe('tool_result');
		if (r.type === 'tool_result') {
			expect(r.toolUseId).toBe('t1');
			expect(r.isError).toBe(true);
			expect(r.content).toBe('aborted');
		}
	});
	it('replaces a placeholder streaming tool_result with an error', () => {
		const parts: MessagePart[] = [
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ content: '', isError: false, streaming: true, toolUseId: 't1', type: 'tool_result' },
		];
		normalizeParts(parts, 'aborted');
		expect(parts).toHaveLength(2);
		const r = parts[1];
		expect(r.type).toBe('tool_result');
		if (r.type === 'tool_result') {
			expect(r.isError).toBe(true);
			expect(r.content).toBe('aborted');
			expect(r.streaming).toBeUndefined();
		}
	});
});
