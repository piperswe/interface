import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, ConversationState, MessageRow, MessagePart, MetaSnapshot } from '$lib/types/conversation';
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
	id: 'm1',
	role: 'assistant',
	content: '',
	model: 'test/model',
	status: 'streaming',
	error: null,
	createdAt: 0,
	meta: null,
	thinking: null,
	parts: [],
	artifacts: [],
};

function state(...messages: MessageRow[]): ConversationState {
	return { messages, inProgress: null };
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
		const out = appendDeltaPart([{ type: 'text', text: 'hi' }], 'text', '!');
		expect(out).toEqual([{ type: 'text', text: 'hi!', textHtml: undefined }]);
	});
	it('preserves textHtml from the trailing part', () => {
		const out = appendDeltaPart([{ type: 'text', text: 'hi', textHtml: '<p>hi</p>' }], 'text', '!');
		expect(out).toEqual([{ type: 'text', text: 'hi!', textHtml: '<p>hi</p>' }]);
	});
	it('starts a new part when types differ', () => {
		const out = appendDeltaPart([{ type: 'thinking', text: 'reflecting' }], 'text', 'word');
		expect(out).toHaveLength(2);
		expect(out[1]).toEqual({ type: 'text', text: 'word' });
	});
	it('starts a new part when parts is empty', () => {
		expect(appendDeltaPart([], 'text', 'A')).toEqual([{ type: 'text', text: 'A' }]);
	});
});

describe('applyDelta', () => {
	it('extends content and the trailing text part', () => {
		const s = state({ ...baseMessage, content: 'foo', parts: [{ type: 'text', text: 'foo' }] });
		const next = applyDelta(s, { messageId: 'm1', content: 'bar' });
		expect(next.messages[0].content).toBe('foobar');
		expect(next.messages[0].parts).toEqual([{ type: 'text', text: 'foobar', textHtml: undefined }]);
	});
	it('appends a new text part when the trailing part is non-text', () => {
		const s = state({
			...baseMessage,
			content: '',
			parts: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
		});
		const next = applyDelta(s, { messageId: 'm1', content: 'hello' });
		expect(next.messages[0].parts).toEqual([
			{ type: 'tool_use', id: 't1', name: 'x', input: {} },
			{ type: 'text', text: 'hello' },
		]);
	});
	it('ignores unknown messageIds', () => {
		const s = state({ ...baseMessage });
		expect(applyDelta(s, { messageId: 'nope', content: 'x' })).toBe(s);
	});
});

describe('applyThinkingDelta', () => {
	it('extends thinking text and the trailing thinking part', () => {
		const s = state({ ...baseMessage, thinking: 'Hmm', parts: [{ type: 'thinking', text: 'Hmm' }] });
		const next = applyThinkingDelta(s, { messageId: 'm1', content: ', ok' });
		expect(next.messages[0].thinking).toBe('Hmm, ok');
		expect(next.messages[0].parts?.at(-1)).toEqual({ type: 'thinking', text: 'Hmm, ok', textHtml: undefined });
	});
	it('starts a new thinking part when previous part is text', () => {
		const s = state({ ...baseMessage, parts: [{ type: 'text', text: 'output' }] });
		const next = applyThinkingDelta(s, { messageId: 'm1', content: 'reflecting' });
		expect(next.messages[0].parts).toHaveLength(2);
		expect(next.messages[0].parts?.[1]).toEqual({ type: 'thinking', text: 'reflecting' });
	});
});

describe('applyToolCall', () => {
	it('appends a tool_use part', () => {
		const s = state({ ...baseMessage });
		const next = applyToolCall(s, { messageId: 'm1', id: 't1', name: 'web_search', input: { q: 'x' } });
		expect(next.messages[0].parts).toEqual([{ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'x' } }]);
	});
	it('is idempotent for duplicate ids', () => {
		const s = state({
			...baseMessage,
			parts: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
		});
		const next = applyToolCall(s, { messageId: 'm1', id: 't1', name: 'x', input: {} });
		expect(next.messages[0].parts).toHaveLength(1);
	});
});

describe('applyToolResult', () => {
	it('appends a tool_result part', () => {
		const s = state({ ...baseMessage });
		const next = applyToolResult(s, { messageId: 'm1', toolUseId: 't1', content: 'done', isError: false });
		expect(next.messages[0].parts?.at(-1)).toEqual({ type: 'tool_result', toolUseId: 't1', content: 'done', isError: false });
	});
	it('overwrites an existing tool_result part in place', () => {
		const s = state({
			...baseMessage,
			parts: [{ type: 'tool_result', toolUseId: 't1', content: 'old', isError: false }],
		});
		const next = applyToolResult(s, { messageId: 'm1', toolUseId: 't1', content: 'new', isError: true });
		expect(next.messages[0].parts).toEqual([{ type: 'tool_result', toolUseId: 't1', content: 'new', isError: true }]);
	});
});

describe('applyToolOutput', () => {
	it('appends a streaming tool_result part if none exists', () => {
		const s = state({ ...baseMessage });
		const next = applyToolOutput(s, { messageId: 'm1', toolUseId: 't1', chunk: 'hello' });
		expect(next.messages[0].parts).toEqual([
			{ type: 'tool_result', toolUseId: 't1', content: 'hello', isError: false, streaming: true },
		]);
	});
	it('extends an existing streaming result', () => {
		const s = state({
			...baseMessage,
			parts: [{ type: 'tool_result', toolUseId: 't1', content: 'hel', isError: false, streaming: true }],
		});
		const next = applyToolOutput(s, { messageId: 'm1', toolUseId: 't1', chunk: 'lo' });
		expect(next.messages[0].parts).toEqual([
			{ type: 'tool_result', toolUseId: 't1', content: 'hello', isError: false, streaming: true },
		]);
	});
});

describe('applyArtifact', () => {
	const artifact: Artifact = {
		id: 'a1',
		messageId: 'm1',
		type: 'code',
		name: 'snippet.ts',
		language: 'typescript',
		version: 1,
		content: 'export {};',
		createdAt: 0,
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
		expect(applySync(state(), { lastMessageId: 'x', lastMessageStatus: 'streaming', lastMessageContent: '' })).toBe('reload');
	});
	it('signals reload when the cached status no longer matches', () => {
		const s = state({ ...baseMessage, status: 'complete' });
		expect(applySync(s, { lastMessageId: 'm1', lastMessageStatus: 'streaming', lastMessageContent: 'x' })).toBe('reload');
	});
	it('returns state unchanged for non-streaming sync (post-completion)', () => {
		const s = state({ ...baseMessage, status: 'complete' });
		expect(applySync(s, { lastMessageId: 'm1', lastMessageStatus: 'complete', lastMessageContent: 'x' })).toBe(s);
	});
	it('replaces content for streaming sync', () => {
		const s = state({ ...baseMessage, content: 'old' });
		const next = applySync(s, { lastMessageId: 'm1', lastMessageStatus: 'streaming', lastMessageContent: 'fresh' });
		expect(next).not.toBe(s);
		expect((next as ConversationState).messages[0].content).toBe('fresh');
	});
	it('replaces parts when the server includes them', () => {
		const s = state({
			...baseMessage,
			content: '',
			parts: [{ type: 'text', text: 'stale' }],
		});
		const fresh: MessagePart[] = [{ type: 'text', text: 'fresh' }];
		const next = applySync(s, {
			lastMessageId: 'm1',
			lastMessageStatus: 'streaming',
			lastMessageContent: 'fresh',
			lastMessageParts: fresh,
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
			parts: [{ type: 'text', text: 'kept' }],
			thinking: 'kept',
		});
		const next = applySync(s, { lastMessageId: 'm1', lastMessageStatus: 'streaming', lastMessageContent: 'x' });
		const m = (next as ConversationState).messages[0];
		expect(m.parts).toEqual([{ type: 'text', text: 'kept' }]);
		expect(m.thinking).toBe('kept');
	});
});

describe('applyMeta', () => {
	it('attaches a meta snapshot', () => {
		const snapshot: MetaSnapshot = {
			startedAt: 1,
			firstTokenAt: 2,
			lastChunk: null,
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
			part: { type: 'info', text: 'compacted' },
		});
		expect(next.messages[0].parts?.at(-1)).toEqual({ type: 'info', text: 'compacted' });
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
		const detach = attachConversationStream('cid', () => s, (next) => (s = next), () => {});
		expect(lastEs?.url).toBe('/c/cid/events');
		lastEs!.emit('delta', { messageId: 'm1', content: '!' });
		expect(s.messages[0].content).toBe('hi!');
		detach();
		expect(lastEs?.closed).toBe(true);
	});

	it('triggers onReload when sync indicates a status mismatch', async () => {
		const { attachConversationStream } = await import('./conversation-stream');
		let s: ConversationState = state({ ...baseMessage, status: 'complete' });
		const onReload = vi.fn();
		const detach = attachConversationStream('cid', () => s, (next) => (s = next), onReload);
		lastEs!.emit('sync', { lastMessageId: 'm1', lastMessageStatus: 'streaming', lastMessageContent: '' });
		expect(onReload).toHaveBeenCalled();
		detach();
	});

	it('triggers onReload on a refresh event', async () => {
		const { attachConversationStream } = await import('./conversation-stream');
		const s = state({ ...baseMessage });
		const onReload = vi.fn();
		const detach = attachConversationStream('cid', () => s, () => {}, onReload);
		lastEs!.emit('refresh', null);
		expect(onReload).toHaveBeenCalled();
		detach();
	});
});
