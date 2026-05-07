import { describe, expect, it } from 'vitest';
import type { MessagePart } from '$lib/types/conversation';
import { buildHistory, buildHistoryWithRowIds } from './history';

describe('buildHistory', () => {
	it('returns user/assistant messages straight through when no system rows are present', () => {
		const msgs = buildHistory([
			{ role: 'user', content: 'hi', parts: null },
			{ role: 'assistant', content: 'hello', parts: null },
		]);
		expect(msgs).toEqual([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		]);
	});

	it('inlines a preceding system row into the next user message', () => {
		const msgs = buildHistory([
			{ role: 'system', content: 'tone: cheerful', parts: null },
			{ role: 'user', content: 'hi', parts: null },
		]);
		expect(msgs).toEqual([{ role: 'user', content: '[tone: cheerful]\n\nhi' }]);
	});

	it('only inlines system content into the immediately following user row', () => {
		const msgs = buildHistory([
			{ role: 'system', content: 'note', parts: null },
			{ role: 'user', content: 'first', parts: null },
			{ role: 'user', content: 'second', parts: null },
		]);
		expect(msgs).toEqual([
			{ role: 'user', content: '[note]\n\nfirst' },
			{ role: 'user', content: 'second' },
		]);
	});

	it('clears pending system content when an assistant row precedes the next user row', () => {
		const msgs = buildHistory([
			{ role: 'system', content: 'note', parts: null },
			{ role: 'assistant', content: 'ok', parts: null },
			{ role: 'user', content: 'next', parts: null },
		]);
		expect(msgs).toEqual([
			{ role: 'assistant', content: 'ok' },
			{ role: 'user', content: 'next' },
		]);
	});

	it('expands assistant rows with tool parts into alternating assistant + tool messages', () => {
		const parts: MessagePart[] = [
			{ type: 'text', text: 'thinking' },
			{ type: 'tool_use', id: 'tu1', name: 'echo', input: { x: 1 } },
			{ type: 'tool_result', toolUseId: 'tu1', content: 'done', isError: false },
			{ type: 'text', text: 'after' },
		];
		const msgs = buildHistory([{ role: 'assistant', content: 'unused-on-tool-rows', parts }]);
		expect(msgs).toHaveLength(3);
		expect(msgs[0].role).toBe('assistant');
		expect(msgs[1].role).toBe('tool');
		expect(msgs[2].role).toBe('assistant');
	});

	it('falls back to the raw `content` column for assistant rows without tool parts', () => {
		const parts: MessagePart[] = [{ type: 'info', text: 'compaction' }];
		const msgs = buildHistory([{ role: 'assistant', content: 'visible content', parts }]);
		expect(msgs).toEqual([{ role: 'assistant', content: 'visible content' }]);
	});
});

describe('buildHistoryWithRowIds', () => {
	it('skips system rows entirely (compaction does not drop them)', () => {
		const out = buildHistoryWithRowIds([
			{ id: 'sys', role: 'system', content: 'note', parts: null },
			{ id: 'u1', role: 'user', content: 'hi', parts: null },
		]);
		expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
		expect(out.rowIdAtIndex).toEqual(['u1']);
	});

	it('emits one row id per LLM message, repeating for tool-expanded assistant rows', () => {
		const parts: MessagePart[] = [
			{ type: 'text', text: 'a' },
			{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} },
			{ type: 'tool_result', toolUseId: 'tu1', content: 'r', isError: false },
		];
		const out = buildHistoryWithRowIds([
			{ id: 'u1', role: 'user', content: 'go', parts: null },
			{ id: 'a1', role: 'assistant', content: '', parts },
		]);
		expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
		expect(out.rowIdAtIndex).toEqual(['u1', 'a1', 'a1']);
	});

	it('preserves rowId alignment across mixed plain + tool-expanded rows', () => {
		const toolParts: MessagePart[] = [
			{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} },
			{ type: 'tool_result', toolUseId: 'tu1', content: 'r', isError: false },
		];
		const out = buildHistoryWithRowIds([
			{ id: 'u1', role: 'user', content: 'one', parts: null },
			{ id: 'a1', role: 'assistant', content: 'plain', parts: null },
			{ id: 'u2', role: 'user', content: 'two', parts: null },
			{ id: 'a2', role: 'assistant', content: '', parts: toolParts },
		]);
		expect(out.messages).toHaveLength(out.rowIdAtIndex.length);
		expect(out.rowIdAtIndex).toEqual(['u1', 'a1', 'u2', 'a2', 'a2']);
	});
});
