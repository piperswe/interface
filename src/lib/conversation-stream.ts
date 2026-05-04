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

export type SyncEvent = {
	lastMessageId: string;
	lastMessageStatus: 'complete' | 'streaming' | 'error';
	lastMessageContent: string;
	lastMessageParts?: MessagePart[] | null;
	lastMessageThinking?: string | null;
};
export type DeltaEvent = { messageId: string; content: string };
export type ThinkingDeltaEvent = { messageId: string; content: string };
export type ToolCallEvent = { messageId: string; id: string; name: string; input: JsonValue };
export type ToolResultEvent = ToolResultRecord & { messageId: string };
export type ToolOutputEvent = { messageId: string; toolUseId: string; chunk: string };
export type ArtifactEvent = { artifact: Artifact };
export type MetaEvent = { messageId: string; snapshot: MetaSnapshot };
export type PartEvent = { messageId: string; part: MessagePart };
export type ModelSwitchEvent = { messageId: string; model: string };

export function patchMessage(
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

export function appendDeltaPart(parts: MessagePart[], kind: 'text' | 'thinking', delta: string): MessagePart[] {
	const last = parts[parts.length - 1];
	if (last && last.type === kind) {
		// Mutate the trailing same-kind part in place. Returning a fresh outer
		// array signals reactivity but avoids reallocating the part itself per
		// streamed token (5000 tokens × array spread + object copy adds up).
		// Preserve existing textHtml so the UI doesn't flicker to raw text
		// while the streaming-markdown renderer picks up the new revision.
		const next = parts.slice();
		const prev = next[next.length - 1] as { type: 'text' | 'thinking'; text: string; textHtml?: string };
		next[next.length - 1] = { type: kind, text: prev.text + delta, textHtml: prev.textHtml };
		return next;
	}
	return [...parts, { type: kind, text: delta }];
}

export function applyDelta(state: ConversationState, ev: DeltaEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({
		...m,
		content: m.content + ev.content,
		parts: appendDeltaPart(m.parts ?? [], 'text', ev.content),
	}));
}

export function applyThinkingDelta(state: ConversationState, ev: ThinkingDeltaEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({
		...m,
		thinking: (m.thinking ?? '') + ev.content,
		parts: appendDeltaPart(m.parts ?? [], 'thinking', ev.content),
	}));
}

export function applyToolCall(state: ConversationState, ev: ToolCallEvent): ConversationState {
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

export function applyToolResult(state: ConversationState, ev: ToolResultEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => {
		const existing = m.toolResults ?? [];
		const alreadyHas = existing.some((r) => r.toolUseId === ev.toolUseId);
		const toolResults = alreadyHas
			? existing.map((r) => (r.toolUseId === ev.toolUseId ? { toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError } : r))
			: [...existing, { toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }];
		const parts = m.parts ?? [];
		const partsHasIt = parts.some((p) => p.type === 'tool_result' && p.toolUseId === ev.toolUseId);
		return {
			...m,
			toolResults,
			parts: partsHasIt
				? parts.map((p) =>
						p.type === 'tool_result' && p.toolUseId === ev.toolUseId
							? { type: 'tool_result', toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }
							: p,
					)
				: [...parts, { type: 'tool_result', toolUseId: ev.toolUseId, content: ev.content, isError: ev.isError }],
		};
	});
}

export function applyToolOutput(state: ConversationState, ev: ToolOutputEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => {
		const existing = m.toolResults ?? [];
		const alreadyHas = existing.some((r) => r.toolUseId === ev.toolUseId);
		const toolResults = alreadyHas
			? existing.map((r) =>
					r.toolUseId === ev.toolUseId ? { ...r, content: r.content + ev.chunk, streaming: true as const } : r,
				)
			: [...existing, { toolUseId: ev.toolUseId, content: ev.chunk, isError: false, streaming: true as const }];
		const parts = m.parts ?? [];
		const partsHasIt = parts.some((p) => p.type === 'tool_result' && p.toolUseId === ev.toolUseId);
		return {
			...m,
			toolResults,
			parts: partsHasIt
				? parts.map((p) =>
						p.type === 'tool_result' && p.toolUseId === ev.toolUseId
							? { type: 'tool_result', toolUseId: ev.toolUseId, content: (p as { content: string }).content + ev.chunk, isError: false, streaming: true as const }
							: p,
					)
				: [...parts, { type: 'tool_result', toolUseId: ev.toolUseId, content: ev.chunk, isError: false, streaming: true as const }],
		};
	});
}

export function applyArtifact(state: ConversationState, ev: ArtifactEvent): ConversationState {
	return patchMessage(state, ev.artifact.messageId, (m) => {
		const existing = m.artifacts ?? [];
		if (existing.some((a) => a.id === ev.artifact.id)) return m;
		return { ...m, artifacts: [...existing, ev.artifact] };
	});
}

export function applySync(state: ConversationState, ev: SyncEvent): ConversationState | 'reload' {
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

export function applyMeta(state: ConversationState, ev: MetaEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({ ...m, meta: ev.snapshot }));
}

export function applyPart(state: ConversationState, ev: PartEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({
		...m,
		parts: [...(m.parts ?? []), ev.part],
	}));
}

export function applyModelSwitch(state: ConversationState, ev: ModelSwitchEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => ({ ...m, model: ev.model }));
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
	const onToolOutput = handle<ToolOutputEvent>(applyToolOutput);
	const onArtifact = handle<ArtifactEvent>(applyArtifact);
	const onMeta = handle<MetaEvent>(applyMeta);
	const onPart = handle<PartEvent>(applyPart);
	const onModelSwitch = handle<ModelSwitchEvent>(applyModelSwitch);
	const onRefresh = () => onReload();

	es.addEventListener('sync', onSync);
	es.addEventListener('delta', onDelta);
	es.addEventListener('thinking_delta', onThinkingDelta);
	es.addEventListener('tool_call', onToolCall);
	es.addEventListener('tool_result', onToolResult);
	es.addEventListener('tool_output', onToolOutput);
	es.addEventListener('artifact', onArtifact);
	es.addEventListener('meta', onMeta);
	es.addEventListener('part', onPart);
	es.addEventListener('model_switch', onModelSwitch);
	es.addEventListener('refresh', onRefresh);

	// If the connection fails (non-2xx, network drop, etc.) the browser will
	// auto-reconnect, but the UI may have drifted. Force a reload so the
	// server state is authoritative rather than letting the user sit on a
	// stale or broken view.
	es.addEventListener('error', onReload);

	return () => es.close();
}
