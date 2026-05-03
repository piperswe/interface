// Background-renders markdown for streaming text/thinking parts on the client
// while a generation is live. Server-rendered HTML already covers completed
// messages; this only fills in the visual gap so the operator sees real
// formatting (lists, code blocks, KaTeX) as the model streams. One async
// render per (message, part-index, text-revision); throttled to one render
// per animation frame.

import { renderMarkdownClient } from './markdown.client';
import type { ConversationState, MessagePart } from '$lib/types/conversation';

type CacheKey = `${string}:${number}`;

export type StreamingMarkdownRunner = {
	pulse(): void;
	dispose(): void;
};

export function createStreamingMarkdownRunner(
	getState: () => ConversationState,
	setState: (next: ConversationState) => void,
): StreamingMarkdownRunner {
	const renderedTextByKey = new Map<CacheKey, string>();
	const inFlight = new Set<CacheKey>();
	let scheduled = 0;
	let cancelled = false;

	function pulse(): void {
		if (scheduled || cancelled) return;
		scheduled = requestAnimationFrame(() => {
			scheduled = 0;
			if (cancelled) return;
			scan();
		});
	}

	function scan(): void {
		const state = getState();
		for (const m of state.messages) {
			if (m.role !== 'assistant' || !m.parts) continue;
			m.parts.forEach((part, i) => {
				if (part.type !== 'text' && part.type !== 'thinking') return;
				if (!part.text) return;
				const key: CacheKey = `${m.id}:${i}`;
				if (renderedTextByKey.get(key) === part.text) return;
				if (inFlight.has(key)) return;
				// Only skip server-rendered parts we haven't started tracking yet.
				// Once we've rendered a part ourselves the cache entry is authoritative,
				// so a stale textHtml preserved by appendDeltaPart won't block re-renders.
				if (!renderedTextByKey.has(key) && typeof part.textHtml === 'string' && part.textHtml.length > 0) return;
				inFlight.add(key);
				renderPart(m.id, i, part).finally(() => {
					inFlight.delete(key);
					// Re-scan in case streaming ended while this render was in flight.
					pulse();
				});
			});
		}
	}

	async function renderPart(messageId: string, index: number, part: MessagePart): Promise<void> {
		if (part.type !== 'text' && part.type !== 'thinking') return;
		const text = part.text;
		let html: string;
		try {
			html = await renderMarkdownClient(text);
		} catch {
			return;
		}
		if (cancelled) return;
		const key: CacheKey = `${messageId}:${index}`;
		renderedTextByKey.set(key, text);

		const prev = getState();
		let touched = false;
		const messages = prev.messages.map((m) => {
			if (m.id !== messageId || !m.parts) return m;
			const next = m.parts.slice();
			const target = next[index];
			if (!target) return m;
			if (target.type !== part.type || target.text !== text) return m;
			next[index] = { ...target, textHtml: html } as MessagePart;
			touched = true;
			return { ...m, parts: next };
		});
		if (touched) setState({ ...prev, messages });
	}

	return {
		pulse,
		dispose() {
			cancelled = true;
			if (scheduled) cancelAnimationFrame(scheduled);
		},
	};
}
