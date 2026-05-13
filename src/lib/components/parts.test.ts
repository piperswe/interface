import { describe, expect, it } from 'vitest';
import type { MessagePart } from '$lib/types/conversation';
import { buildResultsMap, groupParts } from './parts';

describe('buildResultsMap', () => {
	it('indexes tool_result parts by toolUseId', () => {
		const parts: MessagePart[] = [
			{ id: 'a', input: {}, name: 'x', type: 'tool_use' },
			{ content: 'ok', isError: false, toolUseId: 'a', type: 'tool_result' },
			{ content: 'fail', isError: true, toolUseId: 'b', type: 'tool_result' },
		];
		const m = buildResultsMap(parts);
		expect(m.get('a')?.content).toBe('ok');
		expect(m.get('b')?.isError).toBe(true);
		expect(m.has('c')).toBe(false);
	});
	it('returns an empty map for parts with no results', () => {
		const m = buildResultsMap([{ text: 'hi', type: 'text' }]);
		expect(m.size).toBe(0);
	});
});

describe('groupParts', () => {
	it('keeps text parts standalone', () => {
		const parts: MessagePart[] = [{ text: 'hello', type: 'text' }];
		const groups = groupParts(parts, false, new Map());
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('standalone');
	});
	it('drops empty text parts', () => {
		const parts: MessagePart[] = [{ text: '', type: 'text' }];
		expect(groupParts(parts, false, new Map())).toHaveLength(0);
	});
	it('keeps a single non-output part standalone', () => {
		const parts: MessagePart[] = [{ text: 'hmm', type: 'thinking' }];
		const groups = groupParts(parts, true, new Map());
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBe('standalone');
	});
	it('bundles two consecutive non-output parts', () => {
		const parts: MessagePart[] = [
			{ text: 'hmm', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
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
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ text: 'still thinking', type: 'thinking' },
		];
		const groups = groupParts(parts, true, new Map());
		expect(groups[0].kind).toBe('bundle');
		if (groups[0].kind === 'bundle') {
			expect(groups[0].hasActive).toBe(true);
		}
	});
	it('marks bundles with pending tool calls as hasActive while streaming', () => {
		const parts: MessagePart[] = [
			{ text: 'about to call', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
		];
		const groups = groupParts(parts, true, new Map());
		if (groups[0].kind === 'bundle') {
			expect(groups[0].hasActive).toBe(true);
		}
	});
	it('does not mark a bundle active once tool results are present', () => {
		const parts: MessagePart[] = [
			{ text: 'pre', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
		];
		const results = buildResultsMap([{ content: 'ok', isError: false, toolUseId: 't1', type: 'tool_result' }]);
		const groups = groupParts(parts, true, results);
		if (groups[0].kind === 'bundle') {
			expect(groups[0].hasActive).toBe(false);
		}
	});
	it('flushes a bundle when an output part appears between non-output parts', () => {
		const parts: MessagePart[] = [
			{ text: 'pre', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ text: 'answer', type: 'text' },
			{ text: 'reflection', type: 'thinking' },
		];
		const groups = groupParts(parts, false, new Map());
		expect(groups.map((g) => g.kind)).toEqual(['bundle', 'standalone', 'standalone']);
	});
	it('marks bundles with no tool_use as not mixed', () => {
		const parts: MessagePart[] = [
			{ text: 'a', type: 'thinking' },
			{ text: 'b', type: 'thinking' },
		];
		const groups = groupParts(parts, false, new Map());
		expect(groups[0].kind).toBe('bundle');
		if (groups[0].kind === 'bundle') {
			expect(groups[0].mixed).toBe(false);
		}
	});
	it('keeps a bundle active when a tool result is still streaming', () => {
		const parts: MessagePart[] = [
			{ text: 'pre', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
		];
		const results = buildResultsMap([{ content: 'partial…', isError: false, streaming: true, toolUseId: 't1', type: 'tool_result' }]);
		const groups = groupParts(parts, true, results);
		expect(groups[0].kind).toBe('bundle');
		if (groups[0].kind === 'bundle') {
			expect(groups[0].hasActive).toBe(true);
		}
	});
	it('uses a stable key based only on the first part index', () => {
		const parts: MessagePart[] = [
			{ text: 'a', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ content: 'ok', isError: false, toolUseId: 't1', type: 'tool_result' },
		];
		const groups = groupParts(parts, false, buildResultsMap(parts));
		expect(groups[0].kind).toBe('bundle');
		if (groups[0].kind === 'bundle') {
			expect(groups[0].key).toBe('bundle-0');
		}
	});
	it('marks only the last bundle as isLast', () => {
		const parts: MessagePart[] = [
			{ text: 'pre', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ text: 'answer', type: 'text' },
			{ text: 'a', type: 'thinking' },
			{ id: 't2', input: {}, name: 'y', type: 'tool_use' },
		];
		const groups = groupParts(parts, false, new Map());
		const bundles = groups.filter((g) => g.kind === 'bundle');
		expect(bundles).toHaveLength(2);
		expect((bundles[0] as { isLast: boolean }).isLast).toBe(false);
		expect((bundles[1] as { isLast: boolean }).isLast).toBe(true);
	});
	it('marks the only bundle as isLast', () => {
		const parts: MessagePart[] = [
			{ text: 'a', type: 'thinking' },
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
		];
		const groups = groupParts(parts, true, new Map());
		expect(groups[0].kind).toBe('bundle');
		if (groups[0].kind === 'bundle') {
			expect(groups[0].isLast).toBe(true);
		}
	});
	it('keeps a citations part standalone and flushes the preceding bundle', () => {
		const parts: MessagePart[] = [
			{ text: 'pre', type: 'thinking' },
			{ id: 't1', input: {}, name: 'web_search', type: 'tool_use' },
			{ content: 'ok', isError: false, toolUseId: 't1', type: 'tool_result' },
			{ citations: [{ title: 'Example', url: 'https://example.com' }], type: 'citations' },
		];
		const groups = groupParts(parts, false, buildResultsMap(parts));
		expect(groups.map((g) => g.kind)).toEqual(['bundle', 'standalone']);
		const last = groups.at(-1);
		if (last?.kind === 'standalone') {
			expect(last.part.type).toBe('citations');
		}
	});
});
