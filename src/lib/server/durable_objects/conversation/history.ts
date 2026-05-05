import type { Message } from '../../llm/LLM';
import type { MessagePart } from '$lib/types/conversation';
import { parseJson, partsToMessages } from './parts';

type HistoryRow = { role: string; content: string; parts: string | null };

// Convert a sequence of persisted message rows into the LLM `Message[]` shape.
// `system` rows are not assistant messages — they're prefixed onto the next
// user message in square brackets so the model sees them as inline context
// without polluting the role labels.
//
// Assistant rows that contain tool_use/tool_result parts are split into
// alternating `assistant` and `tool` messages via `partsToMessages`. Rows
// without tool parts are emitted as a single `assistant` message with the
// raw `content` column.
export function buildHistory(rows: HistoryRow[]): Message[] {
	const messages: Message[] = [];
	let pendingSystemContent: string | null = null;
	for (const m of rows) {
		if (m.role === 'system') {
			pendingSystemContent = m.content;
		} else if (m.role === 'assistant') {
			pendingSystemContent = null;
			const parsedParts = parseJson<MessagePart[]>(m.parts) ?? [];
			const hasToolParts = parsedParts.some((p) => p.type === 'tool_use' || p.type === 'tool_result');
			if (hasToolParts) {
				messages.push(...partsToMessages(parsedParts));
			} else {
				messages.push({ role: 'assistant', content: m.content });
			}
		} else {
			const prefix = pendingSystemContent ? `[${pendingSystemContent}]\n\n` : '';
			pendingSystemContent = null;
			messages.push({ role: 'user', content: prefix + m.content });
		}
	}
	return messages;
}

// Variant used by compactContext: returns the LLM messages alongside the DB
// row id each one was emitted from, so the caller can map "drop N LLM
// messages" back to soft-deletes by row id. `system` rows are intentionally
// skipped (compaction can't drop them and they're inlined into the next
// user message anyway).
export function buildHistoryWithRowIds(
	rows: Array<{ id: string; role: string; content: string; parts: string | null }>,
): { messages: Message[]; rowIdAtIndex: string[] } {
	const rowIdAtIndex: string[] = [];
	const messages: Message[] = [];
	for (const row of rows) {
		if (row.role === 'assistant') {
			const parsedParts = parseJson<MessagePart[]>(row.parts) ?? [];
			const hasToolParts = parsedParts.some((p) => p.type === 'tool_use' || p.type === 'tool_result');
			if (hasToolParts) {
				const converted = partsToMessages(parsedParts);
				for (const _ of converted) rowIdAtIndex.push(row.id);
				messages.push(...converted);
			} else {
				rowIdAtIndex.push(row.id);
				messages.push({ role: 'assistant', content: row.content });
			}
		} else if (row.role === 'user') {
			rowIdAtIndex.push(row.id);
			messages.push({ role: 'user', content: row.content });
		}
	}
	return { messages, rowIdAtIndex };
}
