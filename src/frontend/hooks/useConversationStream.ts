import { startTransition, useEffect } from 'react';
import type { ConversationState, MetaSnapshot } from '../../types/conversation';

type Setter = (updater: (prev: ConversationState) => ConversationState) => void;

type SyncEvent = {
	lastMessageId: string;
	lastMessageStatus: 'complete' | 'streaming' | 'error';
	lastMessageContent: string;
};

type DeltaEvent = { messageId: string; content: string };

type MetaEvent = { messageId: string; snapshot: MetaSnapshot };

function applyDelta(state: ConversationState, ev: DeltaEvent): ConversationState {
	let touched = false;
	const messages = state.messages.map((m) => {
		if (m.id !== ev.messageId) return m;
		touched = true;
		return { ...m, content: m.content + ev.content };
	});
	if (!touched) return state;
	return { ...state, messages };
}

function applySync(state: ConversationState, ev: SyncEvent): ConversationState | 'reload' {
	const target = state.messages.find((m) => m.id === ev.lastMessageId);
	if (!target || target.status !== ev.lastMessageStatus) return 'reload';
	if (ev.lastMessageStatus !== 'streaming') return state;
	const messages = state.messages.map((m) => (m.id === ev.lastMessageId ? { ...m, content: ev.lastMessageContent } : m));
	return { ...state, messages };
}

function applyMeta(state: ConversationState, ev: MetaEvent): ConversationState {
	let touched = false;
	const messages = state.messages.map((m) => {
		if (m.id !== ev.messageId) return m;
		touched = true;
		return { ...m, meta: ev.snapshot };
	});
	if (!touched) return state;
	return { ...state, messages };
}

export function useConversationStream(conversationId: string, setState: Setter): void {
	useEffect(() => {
		const es = new EventSource(`/c/${conversationId}/events`);

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

		const onDelta = (event: MessageEvent) => {
			const data = JSON.parse(event.data) as DeltaEvent;
			startTransition(() => {
				setState((prev) => applyDelta(prev, data));
			});
		};

		const onMeta = (event: MessageEvent) => {
			const data = JSON.parse(event.data) as MetaEvent;
			startTransition(() => {
				setState((prev) => applyMeta(prev, data));
			});
		};

		const onRefresh = () => {
			location.reload();
		};

		es.addEventListener('sync', onSync);
		es.addEventListener('delta', onDelta);
		es.addEventListener('meta', onMeta);
		es.addEventListener('refresh', onRefresh);

		return () => {
			es.removeEventListener('sync', onSync);
			es.removeEventListener('delta', onDelta);
			es.removeEventListener('meta', onMeta);
			es.removeEventListener('refresh', onRefresh);
			es.close();
		};
	}, [conversationId, setState]);
}
