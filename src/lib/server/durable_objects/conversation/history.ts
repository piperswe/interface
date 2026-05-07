import type { Message } from '../../llm/LLM';
import type { MessagePart } from '$lib/types/conversation';
import { partsToMessages } from './parts';
import { partsFromJson, type BlobEnv } from './blob-store';

type HistoryRow = { role: string; content: string; parts: MessagePart[] | null };
type HistoryRowRaw = { role: string; content: string; parts: string | null };

// Resolve each row's `parts` JSON column into the in-memory `MessagePart[]`
// shape, replacing any `r2-blob:<sha256>` sentinels with the inline base64
// the LLM and renderers expect. Rows without parts pass through unchanged.
//
// Centralized so every history-reading code path goes through the same
// blob-resolution logic.
export async function hydrateRowParts<T extends HistoryRowRaw>(
	rows: T[],
	env: BlobEnv,
): Promise<Array<Omit<T, 'parts'> & { parts: MessagePart[] | null }>> {
	return Promise.all(
		rows.map(async (row) => ({
			...row,
			parts: await partsFromJson(row.parts, env),
		})),
	);
}

// Convert one assistant row into the one-or-more LLM `Message`s it represents.
// Rows whose `parts` contain tool_use/tool_result blocks expand to alternating
// `assistant` + `tool` messages; otherwise the row collapses to a single
// `assistant` message with the raw `content` column.
function assistantRowToMessages(parts: MessagePart[] | null, content: string): Message[] {
	const list = parts ?? [];
	const hasToolParts = list.some((p) => p.type === 'tool_use' || p.type === 'tool_result');
	return hasToolParts ? partsToMessages(list) : [{ role: 'assistant', content }];
}

// Convert a sequence of persisted message rows into the LLM `Message[]` shape.
// `system` rows are not assistant messages — they're prefixed onto the next
// user message in square brackets so the model sees them as inline context
// without polluting the role labels.
export function buildHistory(rows: HistoryRow[]): Message[] {
	const messages: Message[] = [];
	let pendingSystemContent: string | null = null;
	for (const m of rows) {
		if (m.role === 'system') {
			pendingSystemContent = m.content;
			continue;
		}
		if (m.role === 'assistant') {
			pendingSystemContent = null;
			messages.push(...assistantRowToMessages(m.parts, m.content));
			continue;
		}
		const prefix = pendingSystemContent ? `[${pendingSystemContent}]\n\n` : '';
		pendingSystemContent = null;
		messages.push({ role: 'user', content: prefix + m.content });
	}
	return messages;
}

// Variant used by compactContext: returns the LLM messages alongside the DB
// row id each one was emitted from, so the caller can map "drop N LLM
// messages" back to soft-deletes by row id. `system` rows are intentionally
// skipped (compaction can't drop them and they're inlined into the next
// user message anyway).
export function buildHistoryWithRowIds(
	rows: Array<{ id: string; role: string; content: string; parts: MessagePart[] | null }>,
): { messages: Message[]; rowIdAtIndex: string[] } {
	const rowIdAtIndex: string[] = [];
	const messages: Message[] = [];
	for (const row of rows) {
		if (row.role === 'assistant') {
			const converted = assistantRowToMessages(row.parts, row.content);
			for (const _ of converted) rowIdAtIndex.push(row.id);
			messages.push(...converted);
		} else if (row.role === 'user') {
			rowIdAtIndex.push(row.id);
			messages.push({ role: 'user', content: row.content });
		}
	}
	return { messages, rowIdAtIndex };
}
