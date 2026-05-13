import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, ConversationState, MessagePart, MessageRow, MetaSnapshot } from '$lib/types/conversation';
import { assertDefined } from '../../test/assert-defined';
import {
	appendDeltaPart,
	applyArtifact,
	applyDelta,
	applyMeta,
	applyPart,
	applySync,
	applyThinkingDelta,
	applyToolCall,
	applyToolOutput,
	applyToolResult,
	patchMessage,
} from './conversation-stream';

const baseMessage: MessageRow = {
	artifacts: [],
	content: '',
	createdAt: 0,
	error: null,
	id: 'm1',
	meta: null,
	model: 'test/model',
	parts: [],
	role: 'assistant',
	status: 'streaming',
	thinking: null,
};

function state(...messages: MessageRow[]): ConversationState {
	return { inProgress: null, messages };
}

describe('patchMessage', () => {
	it('returns the same reference when no message matches', () => {
		const s = state({ ...baseMessage });
		expect(patchMessage(s, 'nope', (m) => ({ ...m, content: 'x' }))).toBe(s);
	});
	it('applies the patch only to the matching message', () => {
		const s = state({ ...baseMessage, id: 'a' }, { ...baseMessage, id: 'b' });
		const next = patchMessage(s, 'b', (m) => ({ ...m, content: 'B' }));
		expect(next).not.toBe(s);
		expect(next.messages[0].content).toBe('');
		expect(next.messages[1].content).toBe('B');
	});
});

describe('appendDeltaPart', () => {
	it('appends to a trailing matching part', () => {
		const out = appendDeltaPart([{ text: 'hi', type: 'text' }], 'text', '!');
		expect(out).toEqual([{ text: 'hi!', textHtml: undefined, type: 'text' }]);
	});
	it('preserves textHtml from the trailing part', () => {
		const out = appendDeltaPart([{ text: 'hi', textHtml: '<p>hi</p>', type: 'text' }], 'text', '!');
		expect(out).toEqual([{ text: 'hi!', textHtml: '<p>hi</p>', type: 'text' }]);
	});
	it('starts a new part when types differ', () => {
		const out = appendDeltaPart([{ text: 'reflecting', type: 'thinking' }], 'text', 'word');
		expect(out).toHaveLength(2);
		expect(out[1]).toEqual({ text: 'word', type: 'text' });
	});
	it('starts a new part when parts is empty', () => {
		expect(appendDeltaPart([], 'text', 'A')).toEqual([{ text: 'A', type: 'text' }]);
	});
});

describe('applyDelta', () => {
	it('extends content and the trailing text part', () => {
		const s = state({ ...baseMessage, content: 'foo', parts: [{ text: 'foo', type: 'text' }] });
		const next = applyDelta(s, { content: 'bar', messageId: 'm1' });
		expect(next.messages[0].content).toBe('foobar');
		expect(next.messages[0].parts).toEqual([{ text: 'foobar', textHtml: undefined, type: 'text' }]);
	});
	it('appends a new text part when the trailing part is non-text', () => {
		const s = state({
			...baseMessage,
			content: '',
			parts: [{ id: 't1', input: {}, name: 'x', type: 'tool_use' }],
		});
		const next = applyDelta(s, { content: 'hello', messageId: 'm1' });
		expect(next.messages[0].parts).toEqual([
			{ id: 't1', input: {}, name: 'x', type: 'tool_use' },
			{ text: 'hello', type: 'text' },
		]);
	});
	it('ignores unknown messageIds', () => {
		const s = state({ ...baseMessage });
		expect(applyDelta(s, { content: 'x', messageId: 'nope' })).toBe(s);
	});
});

describe('applyThinkingDelta', () => {
	it('extends thinking text and the trailing thinking part', () => {
		const s = state({ ...baseMessage, parts: [{ text: 'Hmm', type: 'thinking' }], thinking: 'Hmm' });
		const next = applyThinkingDelta(s, { content: ', ok', messageId: 'm1' });
		expect(next.messages[0].thinking).toBe('Hmm, ok');
		expect(next.messages[0].parts?.at(-1)).toEqual({ text: 'Hmm, ok', textHtml: undefined, type: 'thinking' });
	});
	it('starts a new thinking part when previous part is text', () => {
		const s = state({ ...baseMessage, parts: [{ text: 'output', type: 'text' }] });
		const next = applyThinkingDelta(s, { content: 'reflecting', messageId: 'm1' });
		expect(next.messages[0].parts).toHaveLength(2);
		expect(next.messages[0].parts?.[1]).toEqual({ text: 'reflecting', type: 'thinking' });
	});
});

describe('applyToolCall', () => {
	it('appends a tool_use part', () => {
		const s = state({ ...baseMessage });
		const next = applyToolCall(s, { id: 't1', input: { q: 'x' }, messageId: 'm1', name: 'web_search' });
		expect(next.messages[0].parts).toEqual([{ id: 't1', input: { q: 'x' }, name: 'web_search', startedAt: undefined, type: 'tool_use' }]);
	});
	it('is idempotent for duplicate ids', () => {
		const s = state({
			...baseMessage,
			parts: [{ id: 't1', input: {}, name: 'x', type: 'tool_use' }],
		});
		const next = applyToolCall(s, { id: 't1', input: {}, messageId: 'm1', name: 'x' });
		expect(next.messages[0].parts).toHaveLength(1);
	});
	it('preserves startedAt when present', () => {
		const s = state({ ...baseMessage });
		const next = applyToolCall(s, { id: 't1', input: {}, messageId: 'm1', name: 'x', startedAt: 12345 });
		expect(next.messages[0].parts?.[0]).toMatchObject({ startedAt: 12345, type: 'tool_use' });
	});
});

describe('applyToolResult', () => {
	it('appends a tool_result part', () => {
		const s = state({ ...baseMessage });
		const next = applyToolResult(s, { content: 'done', isError: false, messageId: 'm1', toolUseId: 't1' });
		expect(next.messages[0].parts?.at(-1)).toEqual({ content: 'done', isError: false, toolUseId: 't1', type: 'tool_result' });
	});
	it('overwrites an existing tool_result part in place', () => {
		const s = state({
			...baseMessage,
			parts: [{ content: 'old', isError: false, toolUseId: 't1', type: 'tool_result' }],
		});
		const next = applyToolResult(s, { content: 'new', isError: true, messageId: 'm1', toolUseId: 't1' });
		expect(next.messages[0].parts).toEqual([{ content: 'new', isError: true, toolUseId: 't1', type: 'tool_result' }]);
	});
	it('preserves startedAt and endedAt timing fields', () => {
		const s = state({ ...baseMessage });
		const next = applyToolResult(s, {
			content: 'done',
			endedAt: 1500,
			isError: false,
			messageId: 'm1',
			startedAt: 1000,
			toolUseId: 't1',
		});
		expect(next.messages[0].parts?.at(-1)).toEqual({
			content: 'done',
			endedAt: 1500,
			isError: false,
			startedAt: 1000,
			toolUseId: 't1',
			type: 'tool_result',
		});
	});
	it('keeps streaming flag when set on the event', () => {
		const s = state({ ...baseMessage });
		const next = applyToolResult(s, {
			content: '',
			isError: false,
			messageId: 'm1',
			startedAt: 100,
			streaming: true,
			toolUseId: 't1',
		});
		expect(next.messages[0].parts?.at(-1)).toMatchObject({ startedAt: 100, streaming: true });
	});
});

describe('applyToolOutput', () => {
	it('appends a streaming tool_result part if none exists', () => {
		const s = state({ ...baseMessage });
		const next = applyToolOutput(s, { chunk: 'hello', messageId: 'm1', toolUseId: 't1' });
		expect(next.messages[0].parts).toEqual([{ content: 'hello', isError: false, streaming: true, toolUseId: 't1', type: 'tool_result' }]);
	});
	it('extends an existing streaming result', () => {
		const s = state({
			...baseMessage,
			parts: [{ content: 'hel', isError: false, streaming: true, toolUseId: 't1', type: 'tool_result' }],
		});
		const next = applyToolOutput(s, { chunk: 'lo', messageId: 'm1', toolUseId: 't1' });
		expect(next.messages[0].parts).toEqual([{ content: 'hello', isError: false, streaming: true, toolUseId: 't1', type: 'tool_result' }]);
	});
});

describe('applyArtifact', () => {
	const artifact: Artifact = {
		content: 'export {};',
		createdAt: 0,
		id: 'a1',
		language: 'typescript',
		messageId: 'm1',
		name: 'snippet.ts',
		type: 'code',
		version: 1,
	};
	it('appends a new artifact', () => {
		const s = state({ ...baseMessage });
		const next = applyArtifact(s, { artifact });
		expect(next.messages[0].artifacts).toEqual([artifact]);
	});
	it('is idempotent on duplicate artifact ids', () => {
		const s = state({ ...baseMessage, artifacts: [artifact] });
		const next = applyArtifact(s, { artifact });
		expect(next.messages[0].artifacts).toHaveLength(1);
	});
});

describe('applySync', () => {
	it('signals reload when the target message is missing', () => {
		expect(applySync(state(), { lastMessageContent: '', lastMessageId: 'x', lastMessageStatus: 'streaming' })).toBe('reload');
	});
	it('signals reload when the cached status no longer matches', () => {
		const s = state({ ...baseMessage, status: 'complete' });
		expect(applySync(s, { lastMessageContent: 'x', lastMessageId: 'm1', lastMessageStatus: 'streaming' })).toBe('reload');
	});
	it('returns state unchanged for non-streaming sync (post-completion)', () => {
		const s = state({ ...baseMessage, status: 'complete' });
		expect(applySync(s, { lastMessageContent: 'x', lastMessageId: 'm1', lastMessageStatus: 'complete' })).toBe(s);
	});
	it('replaces content for streaming sync', () => {
		const s = state({ ...baseMessage, content: 'old' });
		const next = applySync(s, { lastMessageContent: 'fresh', lastMessageId: 'm1', lastMessageStatus: 'streaming' });
		expect(next).not.toBe(s);
		expect((next as ConversationState).messages[0].content).toBe('fresh');
	});
	it('replaces parts when the server includes them', () => {
		const s = state({
			...baseMessage,
			content: '',
			parts: [{ text: 'stale', type: 'text' }],
		});
		const fresh: MessagePart[] = [{ text: 'fresh', type: 'text' }];
		const next = applySync(s, {
			lastMessageContent: 'fresh',
			lastMessageId: 'm1',
			lastMessageParts: fresh,
			lastMessageStatus: 'streaming',
			lastMessageThinking: 'reflection',
		});
		const m = (next as ConversationState).messages[0];
		expect(m.parts).toEqual(fresh);
		expect(m.thinking).toBe('reflection');
	});
	it('keeps existing parts/thinking when not provided', () => {
		const s = state({
			...baseMessage,
			content: '',
			parts: [{ text: 'kept', type: 'text' }],
			thinking: 'kept',
		});
		const next = applySync(s, { lastMessageContent: 'x', lastMessageId: 'm1', lastMessageStatus: 'streaming' });
		const m = (next as ConversationState).messages[0];
		expect(m.parts).toEqual([{ text: 'kept', type: 'text' }]);
		expect(m.thinking).toBe('kept');
	});
});

describe('applyMeta', () => {
	it('attaches a meta snapshot', () => {
		const snapshot: MetaSnapshot = {
			firstTokenAt: 2,
			lastChunk: null,
			startedAt: 1,
			usage: null,
		};
		const next = applyMeta(state({ ...baseMessage }), { messageId: 'm1', snapshot });
		expect(next.messages[0].meta).toBe(snapshot);
	});
});

describe('applyPart', () => {
	it('appends a part to the message timeline', () => {
		const next = applyPart(state({ ...baseMessage }), {
			messageId: 'm1',
			part: { text: 'compacted', type: 'info' },
		});
		expect(next.messages[0].parts?.at(-1)).toEqual({ text: 'compacted', type: 'info' });
	});

	// Regression: the DO emits a final `citations` part via the standard
	// `part` SSE event so the client renders a "Sources" block. Earlier
	// versions broadcast a custom `citations` event that nothing listened
	// to, so the data was lost.
	it('appends a citations part with its sources list', () => {
		const next = applyPart(state({ ...baseMessage }), {
			messageId: 'm1',
			part: {
				citations: [
					{ snippet: 'aa', title: 'A', url: 'https://example.com/a' },
					{ title: 'B', url: 'https://example.com/b' },
				],
				type: 'citations',
			},
		});
		const tail = next.messages[0].parts?.at(-1);
		expect(tail?.type).toBe('citations');
		if (tail?.type === 'citations') {
			expect(tail.citations.map((c) => c.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
		}
	});
});

describe('attachConversationStream', () => {
	type Listener = (event: MessageEvent) => void;
	class FakeEventSource {
		private listeners: Map<string, Set<Listener>> = new Map();
		closed = false;
		constructor(public url: string) {
			lastEs = this;
		}
		addEventListener(type: string, l: Listener) {
			let set = this.listeners.get(type);
			if (!set) {
				set = new Set();
				this.listeners.set(type, set);
			}
			set.add(l);
		}
		removeEventListener(type: string, l: Listener) {
			this.listeners.get(type)?.delete(l);
		}
		close() {
			this.closed = true;
		}
		emit(type: string, data: unknown) {
			const set = this.listeners.get(type);
			if (!set) return;
			const event = new MessageEvent(type, { data: JSON.stringify(data) });
			for (const l of set) l(event);
		}
	}
	let lastEs: FakeEventSource | null = null;
	const origEventSource = (globalThis as { EventSource?: unknown }).EventSource;

	beforeEach(() => {
		lastEs = null;
		(globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
	});
	afterEach(() => {
		(globalThis as { EventSource: unknown }).EventSource = origEventSource;
	});

	it('attaches to /c/:id/events and routes events to apply functions', async () => {
		const { attachConversationStream } = await import('./conversation-stream');
		let s: ConversationState = state({ ...baseMessage, content: 'hi' });
		const detach = attachConversationStream(
			'cid',
			() => s,
			(next) => (s = next),
			() => {},
		);
		expect(lastEs?.url).toBe('/c/cid/events');
		assertDefined(lastEs);
		lastEs.emit('delta', { content: '!', messageId: 'm1' });
		expect(s.messages[0].content).toBe('hi!');
		detach();
		expect(lastEs?.closed).toBe(true);
	});

	it('triggers onReload when sync indicates a status mismatch', async () => {
		const { attachConversationStream } = await import('./conversation-stream');
		let s: ConversationState = state({ ...baseMessage, status: 'complete' });
		const onReload = vi.fn();
		const detach = attachConversationStream(
			'cid',
			() => s,
			(next) => (s = next),
			onReload,
		);
		assertDefined(lastEs);
		lastEs.emit('sync', { lastMessageContent: '', lastMessageId: 'm1', lastMessageStatus: 'streaming' });
		expect(onReload).toHaveBeenCalled();
		detach();
	});

	it('triggers onReload on a refresh event', async () => {
		const { attachConversationStream } = await import('./conversation-stream');
		const s = state({ ...baseMessage });
		const onReload = vi.fn();
		const detach = attachConversationStream(
			'cid',
			() => s,
			() => {},
			onReload,
		);
		assertDefined(lastEs);
		lastEs.emit('refresh', null);
		expect(onReload).toHaveBeenCalled();
		detach();
	});
});
