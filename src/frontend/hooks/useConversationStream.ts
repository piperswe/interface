import { startTransition, useEffect } from 'react';
import type {
	Artifact,
	ConversationState,
	JsonValue,
	MessagePart,
	MessageRow,
	MetaSnapshot,
	ToolResultRecord,
} from '../../types/conversation';

type Setter = (updater: (prev: ConversationState) => ConversationState) => void;

type SyncEvent = {
	lastMessageId: string;
	lastMessageStatus: 'complete' | 'streaming' | 'error';
	lastMessageContent: string;
};

type DeltaEvent = { messageId: string; content: string };
type ThinkingDeltaEvent = { messageId: string; content: string };
type ToolCallEvent = { messageId: string; id: string; name: string; input: JsonValue };
type ToolResultEvent = ToolResultRecord & { messageId: string };
type ArtifactEvent = { artifact: Artifact };
type MetaEvent = { messageId: string; snapshot: MetaSnapshot };
type PartEvent = { messageId: string; part: MessagePart };

// Patch a single message in state.messages by id. Returns the previous state
// unchanged if no message matches — keeps React from re-rendering on stray
// events for messages that were soft-deleted or scrolled out.
function patchMessage(state: ConversationState, id: string, patch: (m: MessageRow) => MessageRow): ConversationState {
	let touched = false;
	const messages = state.messages.map((m) => {
		if (m.id !== id) return m;
		touched = true;
		return patch(m);
	});
	if (!touched) return state;
	return { ...state, messages };
}

// Patch parts in receive order. Text/thinking deltas extend the trailing
// matching part if present, else push a new one. Tool uses/results push
// directly. Idempotent against double-fire by checking ids.
function appendDeltaPart(
	parts: MessagePart[],
	kind: 'text' | 'thinking',
	delta: string,
): MessagePart[] {
	const last = parts[parts.length - 1];
	if (last && last.type === kind) {
		return [...parts.slice(0, -1), { type: kind, text: last.text + delta, textHtml: undefined }];
	}
	return [...parts, { type: kind, text: delta }];
}

function applyDelta(state: ConversationState, ev: DeltaEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({
		...m,
		content: m.content + ev.content,
		parts: appendDeltaPart(m.parts ?? [], 'text', ev.content),
	}));
}

function applyThinkingDelta(state: ConversationState, ev: ThinkingDeltaEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({
		...m,
		thinking: (m.thinking ?? '') + ev.content,
		parts: appendDeltaPart(m.parts ?? [], 'thinking', ev.content),
	}));
}

function applyToolCall(state: ConversationState, ev: ToolCallEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => {
		const existing = m.toolCalls ?? [];
		// Tool calls are unique by id; avoid double-pushing if the event arrives
		// twice (or if the SSR initial state already includes it).
		if (existing.some((tc) => tc.id === ev.id)) return m;
		const parts = m.parts ?? [];
		const partsHasIt = parts.some((p) => p.type === 'tool_use' && p.id === ev.id);
		return {
			...m,
			toolCalls: [...existing, { id: ev.id, name: ev.name, input: ev.input }],
			parts: partsHasIt ? parts : [...parts, { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input }],
		};
	});
}

function applyToolResult(state: ConversationState, ev: ToolResultEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => {
		const existing = m.toolResults ?? [];
		if (existing.some((r) => r.toolUseId === ev.toolUseId)) return m;
		const parts = m.parts ?? [];
		const partsHasIt = parts.some((p) => p.type === 'tool_result' && p.toolUseId === ev.toolUseId);
		return {
			...m,
			toolResults: [...existing, { toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }],
			parts: partsHasIt
				? parts
				: [...parts, { type: 'tool_result', toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }],
		};
	});
}

function applyArtifact(state: ConversationState, ev: ArtifactEvent): ConversationState {
	return patchMessage(state, ev.artifact.messageId, (m) => {
		const existing = m.artifacts ?? [];
		if (existing.some((a) => a.id === ev.artifact.id)) return m;
		return { ...m, artifacts: [...existing, ev.artifact] };
	});
}

function applySync(state: ConversationState, ev: SyncEvent): ConversationState | 'reload' {
	const target = state.messages.find((m) => m.id === ev.lastMessageId);
	if (!target || target.status !== ev.lastMessageStatus) return 'reload';
	if (ev.lastMessageStatus !== 'streaming') return state;
	const messages = state.messages.map((m) => (m.id === ev.lastMessageId ? { ...m, content: ev.lastMessageContent } : m));
	return { ...state, messages };
}

function applyMeta(state: ConversationState, ev: MetaEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({ ...m, meta: ev.snapshot }));
}

function applyPart(state: ConversationState, ev: PartEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({
		...m,
		parts: [...(m.parts ?? []), ev.part],
	}));
}

export function useConversationStream(conversationId: string, setState: Setter): void {
	useEffect(() => {
		const es = new EventSource(`/c/${conversationId}/events`);

		const handle = <T,>(apply: (state: ConversationState, ev: T) => ConversationState) =>
			(event: MessageEvent) => {
				const data = JSON.parse(event.data) as T;
				startTransition(() => {
					setState((prev) => apply(prev, data));
				});
			};

		const onSync = (event: MessageEvent) => {
			const data = JSON.parse(event.data) as SyncEvent;
			let shouldReload = false;
			startTransition(() => {
				setState((prev) => {
					const next = applySync(prev, data);
					if (next === 'reload') {
						shouldReload = true;
						return prev;
					}
					return next;
				});
			});
			if (shouldReload) location.reload();
		};

		const onDelta = handle<DeltaEvent>(applyDelta);
		const onThinkingDelta = handle<ThinkingDeltaEvent>(applyThinkingDelta);
		const onToolCall = handle<ToolCallEvent>(applyToolCall);
		const onToolResult = handle<ToolResultEvent>(applyToolResult);
		const onArtifact = handle<ArtifactEvent>(applyArtifact);
		const onMeta = handle<MetaEvent>(applyMeta);
		const onPart = handle<PartEvent>(applyPart);

		const onRefresh = () => {
			location.reload();
		};

		es.addEventListener('sync', onSync);
		es.addEventListener('delta', onDelta);
		es.addEventListener('thinking_delta', onThinkingDelta);
		es.addEventListener('tool_call', onToolCall);
		es.addEventListener('tool_result', onToolResult);
		es.addEventListener('artifact', onArtifact);
		es.addEventListener('meta', onMeta);
		es.addEventListener('part', onPart);
		es.addEventListener('refresh', onRefresh);

		return () => {
			es.removeEventListener('sync', onSync);
			es.removeEventListener('delta', onDelta);
			es.removeEventListener('thinking_delta', onThinkingDelta);
			es.removeEventListener('tool_call', onToolCall);
			es.removeEventListener('tool_result', onToolResult);
			es.removeEventListener('artifact', onArtifact);
			es.removeEventListener('meta', onMeta);
			es.removeEventListener('part', onPart);
			es.removeEventListener('refresh', onRefresh);
			es.close();
		};
	}, [conversationId, setState]);
}
