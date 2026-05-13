import type { MessagePart } from '$lib/types/conversation';
import type { ContentBlock, Message } from '../../llm/LLM';

export function parseJson<T>(s: string | null): T | null {
	if (!s) return null;
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
}

// Append synthetic tool_result entries for any tool_use parts that don't
// already have a matching result in the timeline. Used on abort and on
// MAX_TOOL_ITERATIONS exit so we never persist a tool_use without a partner —
// providers reject any history that contains an unmatched tool_use block.
//
// A `tool_result` part with `streaming: true` represents a placeholder that
// was seeded before the underlying tool execution completed; if it survives
// to normalization it means the executor never produced a final result
// (mid-tool DO eviction, abort during execute, etc). Replace those with the
// synthetic error too.
export function normalizeParts(parts: MessagePart[], reason: string): void {
	const matched = new Set<string>();
	for (const p of parts) {
		if (p.type === 'tool_result' && !p.streaming) matched.add(p.toolUseId);
	}
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p.type === 'tool_result' && p.streaming && !matched.has(p.toolUseId)) {
			parts[i] = { content: reason, isError: true, toolUseId: p.toolUseId, type: 'tool_result' };
			matched.add(p.toolUseId);
		}
	}
	for (const p of parts) {
		if (p.type !== 'tool_use' || matched.has(p.id)) continue;
		parts.push({ content: reason, isError: true, toolUseId: p.id, type: 'tool_result' });
		matched.add(p.id);
	}
}

// Drop the trailing `text`/`thinking` parts that follow the last
// `tool_use`/`tool_result` boundary. Used on resume after a DO eviction:
// any unflushed text/thinking from the dead generation is partial and is
// cheaper to regenerate than to splice into the LLM history (which would
// require provider-specific prefill). Tool entries are preserved — those
// are the expensive thing to redo.
export function trimTrailingPartialOutput(parts: MessagePart[]): MessagePart[] {
	let cut = parts.length;
	for (let i = parts.length - 1; i >= 0; i--) {
		const p = parts[i];
		if (p.type === 'text' || p.type === 'thinking') {
			cut = i;
			continue;
		}
		break;
	}
	return parts.slice(0, cut);
}

// Dedupe a citations list by URL, preserving the order of first appearance.
// Used at end-of-turn so a turn that calls `web_search` twice for the same
// query doesn't list each URL twice in the persisted `citations` part.
export function dedupeCitationsByUrl<T extends { url: string }>(citations: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const c of citations) {
		if (seen.has(c.url)) continue;
		seen.add(c.url);
		out.push(c);
	}
	return out;
}

// Convert a recovered `parts` timeline into the `assistant` + `tool` Message
// pairs the LLM expects, so a resumed generation sees the work that was
// already done. Mirrors the in-loop construction at the tool execution
// site — the persisted `parts` array uses the same shape the live array
// does, but the LLM API expects them split across `assistant` (with
// tool_use blocks) and `tool` (with tool_result blocks) messages, with
// rounds alternating.
export function partsToMessages(parts: MessagePart[]): Message[] {
	const out: Message[] = [];
	let asstBlocks: ContentBlock[] = [];
	let toolBlocks: ContentBlock[] = [];
	const flushAssistant = () => {
		if (asstBlocks.length > 0) {
			out.push({ content: asstBlocks, role: 'assistant' });
			asstBlocks = [];
		}
	};
	const flushTool = () => {
		if (toolBlocks.length > 0) {
			out.push({ content: toolBlocks, role: 'tool' });
			toolBlocks = [];
		}
	};
	for (const p of parts) {
		if (p.type === 'text') {
			flushTool();
			asstBlocks.push({ text: p.text, type: 'text' });
		} else if (p.type === 'thinking') {
			flushTool();
			asstBlocks.push({
				text: p.text,
				type: 'thinking',
				...(p.signature ? { signature: p.signature } : {}),
			});
		} else if (p.type === 'tool_use') {
			flushTool();
			asstBlocks.push({ id: p.id, input: p.input, name: p.name, thoughtSignature: p.thoughtSignature, type: 'tool_use' });
		} else if (p.type === 'tool_result') {
			flushAssistant();
			toolBlocks.push({
				content: p.content,
				toolUseId: p.toolUseId,
				type: 'tool_result',
				...(p.isError ? { isError: true } : {}),
			});
		}
		// `info` and `citations` parts are UI-only; skip.
	}
	flushAssistant();
	flushTool();
	return out;
}
