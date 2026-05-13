import { describe, expect, it } from 'vitest';
import type { MessagePart } from '$lib/types/conversation';
import { buildHistory, buildHistoryWithRowIds } from './history';

describe('buildHistory', () => {
	it('returns user/assistant messages straight through when no system rows are present', () => {
		const msgs = buildHistory([
			{ content: 'hi', parts: null, role: 'user' },
			{ content: 'hello', parts: null, role: 'assistant' },
		]);
		expect(msgs).toEqual([
			{ content: 'hi', role: 'user' },
			{ content: 'hello', role: 'assistant' },
		]);
	});

	it('inlines a preceding system row into the next user message', () => {
		const msgs = buildHistory([
			{ content: 'tone: cheerful', parts: null, role: 'system' },
			{ content: 'hi', parts: null, role: 'user' },
		]);
		expect(msgs).toEqual([{ content: '[tone: cheerful]\n\nhi', role: 'user' }]);
	});

	it('only inlines system content into the immediately following user row', () => {
		const msgs = buildHistory([
			{ content: 'note', parts: null, role: 'system' },
			{ content: 'first', parts: null, role: 'user' },
			{ content: 'second', parts: null, role: 'user' },
		]);
		expect(msgs).toEqual([
			{ content: '[note]\n\nfirst', role: 'user' },
			{ content: 'second', role: 'user' },
		]);
	});

	it('clears pending system content when an assistant row precedes the next user row', () => {
		const msgs = buildHistory([
			{ content: 'note', parts: null, role: 'system' },
			{ content: 'ok', parts: null, role: 'assistant' },
			{ content: 'next', parts: null, role: 'user' },
		]);
		expect(msgs).toEqual([
			{ content: 'ok', role: 'assistant' },
			{ content: 'next', role: 'user' },
		]);
	});

	it('expands assistant rows with tool parts into alternating assistant + tool messages', () => {
		const parts: MessagePart[] = [
			{ text: 'thinking', type: 'text' },
			{ id: 'tu1', input: { x: 1 }, name: 'echo', type: 'tool_use' },
			{ content: 'done', isError: false, toolUseId: 'tu1', type: 'tool_result' },
			{ text: 'after', type: 'text' },
		];
		const msgs = buildHistory([{ content: 'unused-on-tool-rows', parts, role: 'assistant' }]);
		expect(msgs).toHaveLength(3);
		expect(msgs[0].role).toBe('assistant');
		expect(msgs[1].role).toBe('tool');
		expect(msgs[2].role).toBe('assistant');
	});

	it('falls back to the raw `content` column for assistant rows without tool parts', () => {
		const parts: MessagePart[] = [{ text: 'compaction', type: 'info' }];
		const msgs = buildHistory([{ content: 'visible content', parts, role: 'assistant' }]);
		expect(msgs).toEqual([{ content: 'visible content', role: 'assistant' }]);
	});
});

describe('buildHistoryWithRowIds', () => {
	it('skips system rows entirely (compaction does not drop them)', () => {
		const out = buildHistoryWithRowIds([
			{ content: 'note', id: 'sys', parts: null, role: 'system' },
			{ content: 'hi', id: 'u1', parts: null, role: 'user' },
		]);
		expect(out.messages).toEqual([{ content: 'hi', role: 'user' }]);
		expect(out.rowIdAtIndex).toEqual(['u1']);
	});

	it('emits one row id per LLM message, repeating for tool-expanded assistant rows', () => {
		const parts: MessagePart[] = [
			{ text: 'a', type: 'text' },
			{ id: 'tu1', input: {}, name: 'fn', type: 'tool_use' },
			{ content: 'r', isError: false, toolUseId: 'tu1', type: 'tool_result' },
		];
		const out = buildHistoryWithRowIds([
			{ content: 'go', id: 'u1', parts: null, role: 'user' },
			{ content: '', id: 'a1', parts, role: 'assistant' },
		]);
		expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
		expect(out.rowIdAtIndex).toEqual(['u1', 'a1', 'a1']);
	});

	it('preserves rowId alignment across mixed plain + tool-expanded rows', () => {
		const toolParts: MessagePart[] = [
			{ id: 'tu1', input: {}, name: 'fn', type: 'tool_use' },
			{ content: 'r', isError: false, toolUseId: 'tu1', type: 'tool_result' },
		];
		const out = buildHistoryWithRowIds([
			{ content: 'one', id: 'u1', parts: null, role: 'user' },
			{ content: 'plain', id: 'a1', parts: null, role: 'assistant' },
			{ content: 'two', id: 'u2', parts: null, role: 'user' },
			{ content: '', id: 'a2', parts: toolParts, role: 'assistant' },
		]);
		expect(out.messages).toHaveLength(out.rowIdAtIndex.length);
		expect(out.rowIdAtIndex).toEqual(['u1', 'a1', 'u2', 'a2', 'a2']);
	});
});
