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

// FTS5's `snippet()` interpolates user/LLM content between the open/close
// markers. We can't use `<mark>` directly because the snippet was previously
// rendered into the DOM via `{@html}`, executing any raw HTML in the indexed
// text (e.g. `<img onerror>` from a prior message). Use NUL bytes as
// placeholders, HTML-escape the entire snippet, then re-introduce the marker
// tags. Exported for unit testing.
const SNIPPET_OPEN_SENTINEL = '';
const SNIPPET_CLOSE_SENTINEL = '';

export function _renderSnippetSafe(snippet: string): string {
	// Order matters: escape the user content first so any literal `<mark>`
	// in the indexed text becomes `&lt;mark&gt;`, then swap our sentinels
	// for the real tags.
	const escaped = snippet
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
	return escaped
		.split(SNIPPET_OPEN_SENTINEL)
		.join('<mark>')
		.split(SNIPPET_CLOSE_SENTINEL)
		.join('</mark>');
}

export async function searchConversations(env: Env, query: string, limit = 30): Promise<SearchHit[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const fts = buildFtsQuery(trimmed);
	if (!fts) return [];

	// LEFT JOIN onto conversations to fetch the title for each hit (search
	// rows already store conversation_id). FTS5's `snippet()` returns up to
	// 12 tokens around the match wrapped in the open/close sentinels; we
	// HTML-escape and re-introduce `<mark>` in `_renderSnippetSafe`.
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
		        snippet(conversation_search, 4, char(1), char(2), '…', 12) AS snippet
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
		snippet: _renderSnippetSafe(r.snippet),
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
