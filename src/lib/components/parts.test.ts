import { describe, expect, it } from 'vitest';
import type { MessagePart } from '$lib/types/conversation';
import { buildResultsMap, groupParts } from './parts';

describe('buildResultsMap', () => {
	it('indexes tool_result parts by toolUseId', () => {
		const parts: MessagePart[] = [
			{ type: 'tool_use', id: 'a', name: 'x', input: {} },
			{ type: 'tool_result', toolUseId: 'a', content: 'ok', isError: false },
			{ type: 'tool_result', toolUseId: 'b', content: 'fail', isError: true },
		];
		const m = buildResultsMap(parts);
		expect(m.get('a')?.content).toBe('ok');
		expect(m.get('b')?.isError).toBe(true);
		expect(m.has('c')).toBe(false);
	});
	it('returns an empty map for parts with no results', () => {
		const m = buildResultsMap([{ type: 'text', text: 'hi' }]);
		expect(m.size).toBe(0);
	});
});

describe('groupParts', () => {
	it('keeps text parts standalone', () => {
		const parts: MessagePart[] = [{ type: 'text', text: 'hello' }];
		const groups = groupParts(parts, false, new Map());
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('standalone');
	});
	it('drops empty text parts', () => {
		const parts: MessagePart[] = [{ type: 'text', text: '' }];
		expect(groupParts(parts, false, new Map())).toHaveLength(0);
	});
	it('keeps a single non-output part standalone', () => {
		const parts: MessagePart[] = [{ type: 'thinking', text: 'hmm' }];
		const groups = groupParts(parts, true, new Map());
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('standalone');
	});
	it('bundles two consecutive non-output parts', () => {
		const parts: MessagePart[] = [
			{ type: 'thinking', text: 'hmm' },
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
		];
		const groups = groupParts(parts, false, new Map());
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('bundle');
		if (groups[0].kind === 'bundle') {
			expect(groups[0].parts).toHaveLength(2);
			expect(groups[0].mixed).toBe(true);
		}
	});
	it('marks bundles with active streaming thinking as hasActive', () => {
		const parts: MessagePart[] = [
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
			{ type: 'thinking', text: 'still thinking' },
		];
		const groups = groupParts(parts, true, new Map());
		expect(groups[0].kind).toBe('bundle');
		if (groups[0].kind === 'bundle') {
			expect(groups[0].hasActive).toBe(true);
		}
	});
	it('marks bundles with pending tool calls as hasActive while streaming', () => {
		const parts: MessagePart[] = [
			{ type: 'thinking', text: 'about to call' },
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
		];
		const groups = groupParts(parts, true, new Map());
		if (groups[0].kind === 'bundle') {
			expect(groups[0].hasActive).toBe(true);
		}
	});
	it('does not mark a bundle active once tool results are present', () => {
		const parts: MessagePart[] = [
			{ type: 'thinking', text: 'pre' },
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
		];
		const results = buildResultsMap([{ type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }]);
		const groups = groupParts(parts, true, results);
		if (groups[0].kind === 'bundle') {
			expect(groups[0].hasActive).toBe(false);
		}
	});
	it('flushes a bundle when an output part appears between non-output parts', () => {
		const parts: MessagePart[] = [
			{ type: 'thinking', text: 'pre' },
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
			{ type: 'text', text: 'answer' },
			{ type: 'thinking', text: 'reflection' },
		];
		const groups = groupParts(parts, false, new Map());
		expect(groups.map((g) => g.kind)).toEqual(['bundle', 'standalone', 'standalone']);
	});
	it('marks bundles with no tool_use as not mixed', () => {
		const parts: MessagePart[] = [
			{ type: 'thinking', text: 'a' },
			{ type: 'thinking', text: 'b' },
		];
		const groups = groupParts(parts, false, new Map());
		expect(groups[0].kind).toBe('bundle');
		if (groups[0].kind === 'bundle') {
			expect(groups[0].mixed).toBe(false);
		}
	});
});
