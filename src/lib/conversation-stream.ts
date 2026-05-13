// Live updates for the active conversation page. Subscribes to the SSE
// endpoint at `/c/:id/events` and applies events to a `$state` store. Mirrors
// what the previous React `useConversationStream` hook did, but built around
// Svelte 5 runes.

import { z } from 'zod';
import type {
	Artifact,
	ConversationState,
	JsonValue,
	MessagePart,
	MessageRow,
	MetaSnapshot,
	ToolResultRecord,
} from '$lib/types/conversation';
import { parseJsonWith } from '$lib/zod-utils';

// SSE frames are JSON over the wire — parse defensively. We only check the
// outermost shape (presence of fields the apply* reducers rely on), since
// the inner unions (MessagePart, MetaSnapshot, etc.) duplicated here would
// drift and add zero value when both sides are owned by our codebase.
const messageIdEventSchema = z.object({ messageId: z.string() }).passthrough();
const syncEventSchema = z
	.object({
		lastMessageContent: z.string(),
		lastMessageId: z.string(),
		lastMessageStatus: z.enum(['complete', 'streaming', 'error']),
	})
	.passthrough();

export type SyncEvent = {
	lastMessageId: string;
	lastMessageStatus: 'complete' | 'streaming' | 'error';
	lastMessageContent: string;
	lastMessageParts?: MessagePart[] | null;
	lastMessageThinking?: string | null;
};
export type DeltaEvent = { messageId: string; content: string };
export type ThinkingDeltaEvent = { messageId: string; content: string };
export type ToolCallEvent = {
	messageId: string;
	id: string;
	name: string;
	input: JsonValue;
	startedAt?: number;
};
export type ToolResultEvent = ToolResultRecord & { messageId: string };
export type ToolOutputEvent = { messageId: string; toolUseId: string; chunk: string };
export type ArtifactEvent = { artifact: Artifact };
export type MetaEvent = { messageId: string; snapshot: MetaSnapshot };
export type PartEvent = { messageId: string; part: MessagePart };
export type ModelSwitchEvent = { messageId: string; model: string };

export function patchMessage(state: ConversationState, id: string, patch: (m: MessageRow) => MessageRow): ConversationState {
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
		next[next.length - 1] = { text: prev.text + delta, textHtml: prev.textHtml, type: kind };
		return next;
	}
	return [...parts, { text: delta, type: kind }];
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
		parts: appendDeltaPart(m.parts ?? [], 'thinking', ev.content),
		thinking: (m.thinking ?? '') + ev.content,
	}));
}

export function applyToolCall(state: ConversationState, ev: ToolCallEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => {
		const parts = m.parts ?? [];
		if (parts.some((p) => p.type === 'tool_use' && p.id === ev.id)) return m;
		return {
			...m,
			parts: [...parts, { id: ev.id, input: ev.input, name: ev.name, startedAt: ev.startedAt, type: 'tool_use' }],
		};
	});
}

export function applyToolResult(state: ConversationState, ev: ToolResultEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => {
		const parts = m.parts ?? [];
		const partsHasIt = parts.some((p) => p.type === 'tool_result' && p.toolUseId === ev.toolUseId);
		const next = {
			content: ev.content,
			isError: ev.isError,
			toolUseId: ev.toolUseId,
			type: 'tool_result' as const,
			...(ev.streaming ? { streaming: true as const } : {}),
			...(ev.startedAt !== undefined ? { startedAt: ev.startedAt } : {}),
			...(ev.endedAt !== undefined ? { endedAt: ev.endedAt } : {}),
		};
		return {
			...m,
			parts: partsHasIt ? parts.map((p) => (p.type === 'tool_result' && p.toolUseId === ev.toolUseId ? next : p)) : [...parts, next],
		};
	});
}

export function applyToolOutput(state: ConversationState, ev: ToolOutputEvent): ConversationState {
	return patchMessage(state, ev.messageId, (m) => {
		const parts = m.parts ?? [];
		const partsHasIt = parts.some((p) => p.type === 'tool_result' && p.toolUseId === ev.toolUseId);
		return {
			...m,
			parts: partsHasIt
				? parts.map((p) => {
						if (p.type !== 'tool_result' || p.toolUseId !== ev.toolUseId) return p;
						// Preserve existing timing metadata and isError flag — the
						// original code rebuilt the part from scratch and dropped
						// startedAt/endedAt + force-set isError to false. It also
						// force-cast `content` to string, corrupting parts whose
						// content was a ToolResultBlock[] (e.g. image results).
						if (typeof p.content !== 'string') {
							// Don't concatenate text onto a structured-block result;
							// just keep the existing part. This is defensive — the
							// server doesn't currently emit tool_output after a
							// structured tool_result, but the type union allows it.
							return p;
						}
						return {
							...p,
							content: p.content + ev.chunk,
							streaming: true as const,
						};
					})
				: [...parts, { content: ev.chunk, isError: false, streaming: true as const, toolUseId: ev.toolUseId, type: 'tool_result' }],
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
			const eventData = typeof event.data === 'string' ? event.data : '';
			const validated = parseJsonWith(messageIdEventSchema, eventData);
			if (!validated) return;
			setState(apply(getState(), validated as T));
		};
	}

	const onSync = (event: MessageEvent) => {
		const eventData = typeof event.data === 'string' ? event.data : '';
		const validated = parseJsonWith(syncEventSchema, eventData);
		if (!validated) return;
		const next = applySync(getState(), validated as SyncEvent);
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

	// EventSource fires `error` on transient drops *and* on terminal failures.
	// Only reload when the connection is genuinely closed (readyState=CLOSED);
	// the browser handles transient reconnects on its own and any sync gap is
	// healed by the next `sync` event.
	//
	// Backoff: if `/c/:id/events` is hard-down (401, mid-deploy 500, etc.)
	// each onReload() re-runs the page loader and reopens a fresh EventSource,
	// which CLOSED-trips again immediately — a tight loop hammering the
	// server. Track close timestamps and apply an exponential backoff before
	// triggering the reload. The window resets on the first successful event.
	let closeCount = 0;
	let pendingReload: ReturnType<typeof setTimeout> | null = null;
	let cancelled = false;
	const resetBackoffOnFirstEvent = () => {
		closeCount = 0;
	};
	es.addEventListener('sync', resetBackoffOnFirstEvent);
	es.addEventListener('delta', resetBackoffOnFirstEvent);

	es.addEventListener('error', () => {
		if (es.readyState !== EventSource.CLOSED) return;
		if (cancelled) return;
		closeCount += 1;
		const delayMs = Math.min(15_000, 500 * 2 ** Math.min(closeCount - 1, 5));
		const jitter = Math.floor(Math.random() * 250);
		if (pendingReload) clearTimeout(pendingReload);
		pendingReload = setTimeout(() => {
			pendingReload = null;
			if (!cancelled) onReload();
		}, delayMs + jitter);
	});

	return () => {
		cancelled = true;
		if (pendingReload) {
			clearTimeout(pendingReload);
			pendingReload = null;
		}
		es.close();
	};
}
