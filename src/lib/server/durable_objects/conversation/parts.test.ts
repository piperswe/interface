import { describe, expect, it } from 'vitest';
import type { MessagePart } from '$lib/types/conversation';
import { dedupeCitationsByUrl, normalizeParts, partsToMessages, trimTrailingPartialOutput } from './parts';

describe('dedupeCitationsByUrl', () => {
	it('preserves first-occurrence order and drops later duplicates', () => {
		const out = dedupeCitationsByUrl([
			{ url: 'https://a', title: 'A' },
			{ url: 'https://b', title: 'B' },
			{ url: 'https://a', title: 'A again' },
			{ url: 'https://c', title: 'C' },
			{ url: 'https://b', title: 'B again' },
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
			{ type: 'text', text: 'here it is' },
			{ type: 'citations', citations: [{ url: 'https://example.com', title: 'Example' }] },
		];
		const msgs = partsToMessages(parts);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe('assistant');
		const blocks = msgs[0].content as Array<{ type: string }>;
		expect(blocks.map((b) => b.type)).toEqual(['text']);
	});

	it('skips info parts when building LLM history', () => {
		const parts: MessagePart[] = [
			{ type: 'text', text: 'answer' },
			{ type: 'info', text: 'context compacted' },
		];
		const msgs = partsToMessages(parts);
		expect(msgs).toHaveLength(1);
		const blocks = msgs[0].content as Array<{ type: string }>;
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('text');
	});

	it('splits assistant tool_use and tool_result into alternating roles', () => {
		const parts: MessagePart[] = [
			{ type: 'text', text: 'thinking out loud' },
			{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
			{ type: 'tool_result', toolUseId: 't1', content: 'hit', isError: false },
			{ type: 'text', text: 'final' },
		];
		const msgs = partsToMessages(parts);
		expect(msgs.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
	});

	it('preserves array tool_result content (text + image) so sandbox_load_image survives replay', () => {
		const parts: MessagePart[] = [
			{ type: 'tool_use', id: 't1', name: 'sandbox_load_image', input: { path: '/workspace/x.png' } },
			{
				type: 'tool_result',
				toolUseId: 't1',
				content: [
					{ type: 'text', text: 'Loaded x.png.' },
					{ type: 'image', mimeType: 'image/png', data: 'AAAA' },
				],
				isError: false,
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
		expect(toolBlock.content).toContainEqual({ type: 'text', text: 'Loaded x.png.' });
		expect(toolBlock.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
	});
});

describe('trimTrailingPartialOutput', () => {
	it('trims trailing text/thinking parts past the last tool boundary', () => {
		const parts: MessagePart[] = [
			{ type: 'text', text: 'one' },
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
			{ type: 'tool_result', toolUseId: 't1', content: 'r', isError: false },
			{ type: 'text', text: 'partial' },
		];
		const out = trimTrailingPartialOutput(parts);
		expect(out.map((p) => p.type)).toEqual(['text', 'tool_use', 'tool_result']);
	});
	it('keeps everything when no trailing partial output exists', () => {
		const parts: MessagePart[] = [
			{ type: 'text', text: 'a' },
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
			{ type: 'tool_result', toolUseId: 't1', content: 'r', isError: false },
		];
		const out = trimTrailingPartialOutput(parts);
		expect(out).toEqual(parts);
	});
});

describe('normalizeParts', () => {
	it('appends synthetic error tool_results for unmatched tool_use', () => {
		const parts: MessagePart[] = [{ type: 'tool_use', id: 't1', name: 'x', input: {} }];
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
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
			{ type: 'tool_result', toolUseId: 't1', content: '', isError: false, streaming: true },
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
