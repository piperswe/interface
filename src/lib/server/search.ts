// Conversation full-text search backed by D1's FTS5 virtual table.
//
// Schema lives in migration 0009. We store:
//   - one synthetic row per conversation title (message_id = '__title__'),
//     written by D1 code paths (createConversation, #writeTitle).
//   - one row per persisted user / assistant message body, written by the
//     Conversation Durable Object's `#indexMessage` write hook.
//
// Reads return matched rows enriched with the conversation title so the
// Cmd-K palette can render `Title — snippet` results that link directly
// to the matching message.

import { now as nowMs } from './clock';

const TITLE_SENTINEL = '__title__';

export type SearchHit = {
	conversationId: string;
	conversationTitle: string;
	messageId: string | null;
	role: 'title' | 'user' | 'assistant';
	snippet: string;
	createdAt: number;
};

// FTS5 reserves a handful of operators (AND, OR, NOT, NEAR, ", *, (, )).
// Users typing free-form queries shouldn't have to know that, so we wrap
// each whitespace-separated token in double quotes (escaping internal "s),
// turning the whole thing into a phrase-AND query. Empty input → empty
// FTS5 query (caller guards against that).
function buildFtsQuery(input: string): string {
	const tokens = input
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => '"' + t.replace(/"/g, '""') + '"');
	return tokens.join(' ');
}

export function _ftsQueryForTest(input: string): string {
	return buildFtsQuery(input);
}

export async function searchConversations(env: Env, query: string, limit = 30): Promise<SearchHit[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const fts = buildFtsQuery(trimmed);
	if (!fts) return [];

	// LEFT JOIN onto conversations to fetch the title for each hit (search
	// rows already store conversation_id). FTS5's `snippet()` returns up to
	// 12 tokens around the match wrapped in `<mark>`...`</mark>`.
	type Row = {
		conversation_id: string;
		message_id: string;
		role: string;
		created_at: number;
		conversation_title: string | null;
		archived_at: number | null;
		snippet: string;
	};
	const result = await env.DB.prepare(
		`SELECT s.conversation_id, s.message_id, s.role, s.created_at,
		        c.title AS conversation_title, c.archived_at,
		        snippet(conversation_search, 4, '<mark>', '</mark>', '…', 12) AS snippet
		   FROM conversation_search s
		   JOIN conversations c ON c.id = s.conversation_id
		  WHERE conversation_search MATCH ?
		    AND c.archived_at IS NULL
		  ORDER BY rank
		  LIMIT ?`,
	)
		.bind(fts, limit)
		.all<Row>();

	return (result.results ?? []).map((r) => ({
		conversationId: r.conversation_id,
		conversationTitle: r.conversation_title ?? '(untitled)',
		messageId: r.message_id === TITLE_SENTINEL ? null : r.message_id,
		role: (r.role === 'title' || r.role === 'user' || r.role === 'assistant') ? r.role : 'assistant',
		snippet: r.snippet,
		createdAt: r.created_at,
	}));
}

// Replace the title row for a conversation. Called from createConversation
// (initial 'New conversation') and from the DO's #writeTitle.
export async function indexTitle(env: Env, conversationId: string, title: string, ts: number = nowMs()): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM conversation_search WHERE conversation_id = ? AND message_id = ?`,
	)
		.bind(conversationId, TITLE_SENTINEL)
		.run();
	await env.DB.prepare(
		`INSERT INTO conversation_search (conversation_id, message_id, role, created_at, text)
		 VALUES (?, ?, 'title', ?, ?)`,
	)
		.bind(conversationId, TITLE_SENTINEL, ts, title)
		.run();
}

// Insert or replace the search row for a single message. The DO calls this
// when a user message is appended and when an assistant message completes.
export async function indexMessage(
	env: Env,
	args: { conversationId: string; messageId: string; role: 'user' | 'assistant'; text: string; createdAt: number },
): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM conversation_search WHERE conversation_id = ? AND message_id = ?`,
	)
		.bind(args.conversationId, args.messageId)
		.run();
	const trimmed = args.text.trim();
	if (!trimmed) return;
	await env.DB.prepare(
		`INSERT INTO conversation_search (conversation_id, message_id, role, created_at, text)
		 VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(args.conversationId, args.messageId, args.role, args.createdAt, trimmed)
		.run();
}

export async function unindexConversation(env: Env, conversationId: string): Promise<void> {
	await env.DB.prepare(
		`DELETE FROM conversation_search WHERE conversation_id = ?`,
	)
		.bind(conversationId)
		.run();
}
