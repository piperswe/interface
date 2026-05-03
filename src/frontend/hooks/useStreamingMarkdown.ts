import { useEffect, useRef } from 'react';
import type { ConversationState, MessagePart } from '../../types/conversation';
import { renderMarkdownClient } from '../markdown.client';

type Setter = (updater: (prev: ConversationState) => ConversationState) => void;

type CacheKey = `${string}:${number}`; // messageId:partIndex

// Background-renders markdown for streaming text/thinking parts. Server-side
// completed messages already carry `textHtml`; this only fills in the gap
// during a live turn so the operator sees formatting (paragraphs, lists,
// **bold**, code blocks, math) as the model streams.
//
// One async render per (message, part-index) per text revision. Throttled to
// at most one render per animation frame to handle character-by-character
// streaming without thrashing.
export function useStreamingMarkdown(state: ConversationState, setState: Setter): void {
	const renderedTextByKey = useRef<Map<CacheKey, string>>(new Map());
	const inFlight = useRef<Set<CacheKey>>(new Set());
	const pending = useRef(false);

	useEffect(() => {
		if (pending.current) return;
		pending.current = true;
		const handle = requestAnimationFrame(() => {
			pending.current = false;
			scheduleRender();
		});
		return () => cancelAnimationFrame(handle);

		function scheduleRender(): void {
			for (const m of state.messages) {
				if (m.role !== 'assistant' || !m.parts) continue;
				m.parts.forEach((part, i) => {
					if (part.type !== 'text' && part.type !== 'thinking') return;
					if (!part.text) return;
					if (typeof part.textHtml === 'string' && part.textHtml.length > 0) return;
					const key: CacheKey = `${m.id}:${i}`;
					if (renderedTextByKey.current.get(key) === part.text) return;
					if (inFlight.current.has(key)) return;
					inFlight.current.add(key);
					renderPart(m.id, i, part).finally(() => inFlight.current.delete(key));
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
			const key: CacheKey = `${messageId}:${index}`;
			renderedTextByKey.current.set(key, text);
			setState((prev) => {
				let touched = false;
				const messages = prev.messages.map((m) => {
					if (m.id !== messageId || !m.parts) return m;
					const next = m.parts.slice();
					const target = next[index];
					if (!target) return m;
					if (target.type !== part.type || target.text !== text) {
						// Text moved on while we were rendering — skip; the next
						// rAF tick will pick up the newer revision.
						return m;
					}
					next[index] = { ...target, textHtml: html } as MessagePart;
					touched = true;
					return { ...m, parts: next };
				});
				if (!touched) return prev;
				return { ...prev, messages };
			});
		}
	}, [state, setState]);
}
