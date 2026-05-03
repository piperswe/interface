// Live updates for the active conversation page. Subscribes to the SSE
// endpoint at `/c/:id/events` and applies events to a `$state` store. Mirrors
// what the previous React `useConversationStream` hook did, but built around
// Svelte 5 runes.

import type {
	Artifact,
	ConversationState,
	JsonValue,
	MessagePart,
	MessageRow,
	MetaSnapshot,
	ToolResultRecord,
} from '$lib/types/conversation';

type SyncEvent = {
	lastMessageId: string;
	lastMessageStatus: 'complete' | 'streaming' | 'error';
	lastMessageContent: string;
	lastMessageParts?: MessagePart[] | null;
	lastMessageThinking?: string | null;
};
type DeltaEvent = { messageId: string; content: string };
type ThinkingDeltaEvent = { messageId: string; content: string };
type ToolCallEvent = { messageId: string; id: string; name: string; input: JsonValue };
type ToolResultEvent = ToolResultRecord & { messageId: string };
type ArtifactEvent = { artifact: Artifact };
type MetaEvent = { messageId: string; snapshot: MetaSnapshot };
type PartEvent = { messageId: string; part: MessagePart };

function patchMessage(
	state: ConversationState,
	id: string,
	patch: (m: MessageRow) => MessageRow,
): ConversationState {
	let touched = false;
	const messages = state.messages.map((m) => {
		if (m.id !== id) return m;
		touched = true;
		return patch(m);
	});
	if (!touched) return state;
	return { ...state, messages };
}

function appendDeltaPart(parts: MessagePart[], kind: 'text' | 'thinking', delta: string): MessagePart[] {
	const last = parts[parts.length - 1];
	if (last && last.type === kind) {
		// Preserve existing textHtml so the UI doesn't flicker to raw text
		// while the streaming-markdown renderer picks up the new revision.
		return [
			...parts.slice(0, -1),
			{ type: kind, text: last.text + delta, textHtml: (last as { textHtml?: string }).textHtml },
		];
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
				: [
						...parts,
						{ type: 'tool_result', toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError },
					],
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
	const messages = state.messages.map((m) => {
		if (m.id !== ev.lastMessageId) return m;
		const next = { ...m, content: ev.lastMessageContent };
		// `parts`/`thinking` are sent for in-flight assistant messages so
		// reconnecting clients pick up the timeline as the server has it.
		// Older servers omit them — fall back to the existing values.
		if (ev.lastMessageParts !== undefined) {
			next.parts = ev.lastMessageParts ?? [];
		}
		if (ev.lastMessageThinking !== undefined) {
			next.thinking = ev.lastMessageThinking;
		}
		return next;
	});
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

export function attachConversationStream(
	conversationId: string,
	getState: () => ConversationState,
	setState: (next: ConversationState) => void,
	onReload: () => void,
): () => void {
	const es = new EventSource(`/c/${conversationId}/events`);

	function handle<T>(apply: (state: ConversationState, ev: T) => ConversationState) {
		return (event: MessageEvent) => {
			const data = JSON.parse(event.data) as T;
			setState(apply(getState(), data));
		};
	}

	const onSync = (event: MessageEvent) => {
		const data = JSON.parse(event.data) as SyncEvent;
		const next = applySync(getState(), data);
		if (next === 'reload') onReload();
		else setState(next);
	};

	const onDelta = handle<DeltaEvent>(applyDelta);
	const onThinkingDelta = handle<ThinkingDeltaEvent>(applyThinkingDelta);
	const onToolCall = handle<ToolCallEvent>(applyToolCall);
	const onToolResult = handle<ToolResultEvent>(applyToolResult);
	const onArtifact = handle<ArtifactEvent>(applyArtifact);
	const onMeta = handle<MetaEvent>(applyMeta);
	const onPart = handle<PartEvent>(applyPart);
	const onRefresh = () => onReload();

	es.addEventListener('sync', onSync);
	es.addEventListener('delta', onDelta);
	es.addEventListener('thinking_delta', onThinkingDelta);
	es.addEventListener('tool_call', onToolCall);
	es.addEventListener('tool_result', onToolResult);
	es.addEventListener('artifact', onArtifact);
	es.addEventListener('meta', onMeta);
	es.addEventListener('part', onPart);
	es.addEventListener('refresh', onRefresh);

	return () => es.close();
}
