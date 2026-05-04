import { DurableObject } from 'cloudflare:workers';
import { routeLLM } from '../llm/route';
import { compactHistory } from '../llm/context';
import { formatError } from '../llm/errors';
import type LLM from '../llm/LLM';
import type { ChatRequest, ContentBlock, Message, ReasoningEffort, StreamEvent, ToolDefinition, Usage } from '../llm/LLM';
import { ToolRegistry } from '../tools/registry';
import type { ToolCitation } from '../tools/registry';
import { fetchUrlTool } from '../tools/fetch_url';
import { createWebSearchTool } from '../tools/web_search';
import { createYnabTools } from '../tools/ynab';
import { KagiSearchBackend } from '../search/kagi';
import { McpHttpClient } from '../mcp/client';
import { listMcpServers } from '../mcp_servers';
import { listSubAgents } from '../sub_agents';
import { createAgentTool } from '../tools/agent';
import { createGetModelsTool } from '../tools/get_models';
import { createSwitchModelTool } from '../tools/switch_model';
import { getSetting, getSystemPrompt, getUserBio } from '../settings';
import { registerSandboxTools } from '../tools/sandbox';
import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';
import type { ReasoningConfig } from '../llm/LLM';
import { renderMarkdown, renderArtifactCode } from '../markdown';
import { now as nowMs, uuid } from '../clock';
import type { AddMessageResult, Artifact, ArtifactType, ConversationState, MessageRow, MetaSnapshot } from '$lib/types/conversation';
import { getResolvedModel, listAllModels } from '../providers/models';
import { buildGlobalModelId } from '../providers/types';
import type { ProviderModel, ResolvedModel } from '../providers/types';
import type { SubAgentRow } from '../sub_agents';
import type { McpServerRow } from '../mcp/types';

export type { AddMessageResult, Artifact, ArtifactType, ConversationState, MessageRow, MetaSnapshot };

const PING_INTERVAL_MS = 25_000;
const TITLE_MAX = 60;
const MAX_TOOL_ITERATIONS = 10;
const MCP_TOOL_CACHE_TTL_MS = 60_000;
const CONTEXT_CACHE_TTL_MS = 30_000;
// SQL fragment used by every history / state fetch on the messages table.
const COMPLETE_PREDICATE = "status = 'complete' AND deleted_at IS NULL";

// Per-turn snapshot of the D1-backed configuration the generation loop
// depends on. Cached per-DO with a TTL so a chat turn doesn't issue a
// dozen serial round trips for static-ish settings. Settings saves
// don't propagate cross-isolate, but the TTL is short enough that a
// stale value clears within seconds.
type ConversationContext = {
	systemPrompt: string | null;
	userBio: string | null;
	allModels: ProviderModel[];
	subAgents: SubAgentRow[];
	mcpServers: McpServerRow[];
};

import type {
	JsonValue,
	MessagePart,
	ToolCallRecord as RecordedToolCall,
	ToolResultRecord as RecordedToolResult,
} from '$lib/types/conversation';

function parseJson<T>(s: string | null): T | null {
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
function normalizeParts(parts: MessagePart[], reason: string): void {
	const matched = new Set<string>();
	for (const p of parts) {
		if (p.type === 'tool_result' && !p.streaming) matched.add(p.toolUseId);
	}
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p.type === 'tool_result' && p.streaming && !matched.has(p.toolUseId)) {
			parts[i] = { type: 'tool_result', toolUseId: p.toolUseId, content: reason, isError: true };
			matched.add(p.toolUseId);
		}
	}
	for (const p of parts) {
		if (p.type !== 'tool_use' || matched.has(p.id)) continue;
		parts.push({ type: 'tool_result', toolUseId: p.id, content: reason, isError: true });
		matched.add(p.id);
	}
}

// Drop the trailing `text`/`thinking` parts that follow the last
// `tool_use`/`tool_result` boundary. Used on resume after a DO eviction:
// any unflushed text/thinking from the dead generation is partial and is
// cheaper to regenerate than to splice into the LLM history (which would
// require provider-specific prefill). Tool entries are preserved — those
// are the expensive thing to redo.
function trimTrailingPartialOutput(parts: MessagePart[]): MessagePart[] {
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

// Idempotent helper: run ALTER, swallow "duplicate column" errors so the same
// migration can be safely replayed on a DO that pre-dates the schema
// versioning table.
function alterIgnoreExists(sql: SqlStorage, stmt: string): void {
	try {
		sql.exec(stmt);
	} catch {
		// column already exists
	}
}

// Versioned schema migrations. Append-only — never edit a published entry.
// Migration 1 is the legacy CREATE+ALTER bundle; all DOs that pre-date the
// `_meta` table will pass through it on first boot, but each ALTER swallows
// "column exists" errors so it's safe.
const MIGRATIONS: { version: number; up: (sql: SqlStorage) => void }[] = [
	{
		version: 1,
		up: (sql) => {
			sql.exec(`
				CREATE TABLE IF NOT EXISTS messages (
					id TEXT PRIMARY KEY,
					role TEXT NOT NULL,
					content TEXT NOT NULL,
					model TEXT,
					status TEXT NOT NULL,
					error TEXT,
					created_at INTEGER NOT NULL,
					started_at INTEGER,
					first_token_at INTEGER,
					last_chunk_json TEXT,
					usage_json TEXT,
					generation_json TEXT,
					provider TEXT,
					thinking TEXT,
					tool_calls TEXT,
					tool_results TEXT,
					parent_id TEXT,
					deleted_at INTEGER,
					artifact_ids TEXT,
					parts TEXT
				)
			`);
			sql.exec(`
				CREATE TABLE IF NOT EXISTS artifacts (
					id TEXT PRIMARY KEY,
					message_id TEXT NOT NULL,
					type TEXT NOT NULL,
					name TEXT,
					language TEXT,
					version INTEGER NOT NULL DEFAULT 1,
					content TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`);
			alterIgnoreExists(sql, 'ALTER TABLE artifacts ADD COLUMN language TEXT');
			sql.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id)');
			for (const stmt of [
				'ALTER TABLE messages ADD COLUMN started_at INTEGER',
				'ALTER TABLE messages ADD COLUMN first_token_at INTEGER',
				'ALTER TABLE messages ADD COLUMN last_chunk_json TEXT',
				'ALTER TABLE messages ADD COLUMN usage_json TEXT',
				'ALTER TABLE messages ADD COLUMN generation_json TEXT',
				'ALTER TABLE messages ADD COLUMN provider TEXT',
				'ALTER TABLE messages ADD COLUMN thinking TEXT',
				'ALTER TABLE messages ADD COLUMN tool_calls TEXT',
				'ALTER TABLE messages ADD COLUMN tool_results TEXT',
				'ALTER TABLE messages ADD COLUMN parent_id TEXT',
				'ALTER TABLE messages ADD COLUMN deleted_at INTEGER',
				'ALTER TABLE messages ADD COLUMN artifact_ids TEXT',
				'ALTER TABLE messages ADD COLUMN parts TEXT',
			]) {
				alterIgnoreExists(sql, stmt);
			}
		},
	},
	{
		version: 2,
		up: (sql) => {
			// Server-rendered HTML cached alongside the raw content, so page
			// loads don't have to re-run marked + Shiki + KaTeX. Populated at
			// generation completion; null for legacy rows (the SSR path falls
			// back to live rendering when missing).
			alterIgnoreExists(sql, 'ALTER TABLE messages ADD COLUMN content_html TEXT');
			alterIgnoreExists(sql, 'ALTER TABLE messages ADD COLUMN thinking_html TEXT');
			alterIgnoreExists(sql, 'ALTER TABLE messages ADD COLUMN parts_html TEXT');
			alterIgnoreExists(sql, 'ALTER TABLE artifacts ADD COLUMN content_html TEXT');
		},
	},
	{
		version: 3,
		up: (sql) => {
			// Backfill `parts` from any row that still has only the legacy
			// tool_calls/tool_results/thinking columns set, using the same
			// shape `buildLegacyParts` constructs at read time. Rows that
			// already have a `parts` JSON keep it.
			//
			// `parts_html` is folded into `parts` (the enriched parts JSON
			// has `textHtml` baked into text/thinking entries; readers tolerate
			// either shape). For rows where `parts_html` is set but `parts` is
			// not, copy across.
			//
			// Then drop the redundant columns. SQLite (3.35+) supports
			// `DROP COLUMN`; Cloudflare's DO SQLite is recent enough.
			sql.exec(
				`UPDATE messages SET parts = parts_html WHERE parts IS NULL AND parts_html IS NOT NULL`,
			);
			// Backfill from legacy tool_calls/tool_results columns for rows
			// missing `parts` entirely. The JSON shape mirrors `buildLegacyParts`:
			// thinking → text → tool_use[] → tool_result[].
			const rows = sql
				.exec(
					`SELECT id, content, thinking, tool_calls, tool_results FROM messages
					 WHERE parts IS NULL AND (thinking IS NOT NULL OR tool_calls IS NOT NULL OR tool_results IS NOT NULL)`,
				)
				.toArray() as unknown as Array<{
				id: string;
				content: string;
				thinking: string | null;
				tool_calls: string | null;
				tool_results: string | null;
			}>;
			for (const r of rows) {
				const tcs: Array<{ id: string; name: string; input: unknown; thoughtSignature?: string }> = (() => {
					try {
						return r.tool_calls ? JSON.parse(r.tool_calls) : [];
					} catch {
						return [];
					}
				})();
				const trs: Array<{ toolUseId: string; content: string; isError: boolean }> = (() => {
					try {
						return r.tool_results ? JSON.parse(r.tool_results) : [];
					} catch {
						return [];
					}
				})();
				const built: Array<Record<string, unknown>> = [];
				if (r.thinking) built.push({ type: 'thinking', text: r.thinking });
				if (r.content) built.push({ type: 'text', text: r.content });
				for (const tc of tcs) built.push({ type: 'tool_use', ...tc });
				for (const tr of trs)
					built.push({ type: 'tool_result', toolUseId: tr.toolUseId, content: tr.content, isError: tr.isError });
				if (built.length > 0) {
					sql.exec('UPDATE messages SET parts = ? WHERE id = ?', JSON.stringify(built), r.id);
				}
			}
			// Drop the redundant columns. `generation_json` was always-null
			// after the OpenRouter generation-stats removal.
			try { sql.exec('ALTER TABLE messages DROP COLUMN tool_calls'); } catch { /* not present */ }
			try { sql.exec('ALTER TABLE messages DROP COLUMN tool_results'); } catch { /* not present */ }
			try { sql.exec('ALTER TABLE messages DROP COLUMN parts_html'); } catch { /* not present */ }
			try { sql.exec('ALTER TABLE messages DROP COLUMN generation_json'); } catch { /* not present */ }
		},
	},
];

export default class ConversationDurableObject extends DurableObject<Env> {
	#sql: SqlStorage;
	#subscribers = new Set<{ controller: ReadableStreamDefaultController<Uint8Array>; nextId: number }>();
	// Live mirror of the assistant message currently being generated. Holds
	// the running text/thinking/parts so a client that subscribes (or
	// reloads) mid-stream gets a complete snapshot — the SQL row's
	// `content` / `thinking` / `parts` columns are only persisted at
	// end-of-turn, so we can't rely on them mid-flight.
	//
	// `abortController` cancels both the underlying provider HTTP fetch
	// (`llm.chat({ signal })`) and any in-flight tool execution
	// (`registry.execute({ signal })`). `startedAt`/`firstTokenAt` are
	// hoisted onto the mirror so abortGeneration can persist a meta
	// snapshot for the cut-short row.
	#inProgress: {
		messageId: string;
		content: string;
		thinking: string;
		parts: MessagePart[];
		abortController: AbortController;
		startedAt: number;
		firstTokenAt: number;
		lastChunk: unknown | null;
		usage: Usage | null;
		providerID: string | null;
	} | null = null;
	#pingInterval: ReturnType<typeof setInterval> | null = null;
	#encoder = new TextEncoder();
	// Per-DO cache of MCP tool descriptors keyed by server id. The clients
	// themselves are reused inside the closure so we keep one instance per
	// server. Refreshed on TTL expiry or when the cached entry is cleared.
	#mcpCache = new Map<number, { fetchedAt: number; client: McpHttpClient; tools: import('../mcp/types').McpToolDescriptor[] }>();
	// Concurrency guard for resume-after-eviction. While set, addUserMessage
	// returns `busy` and detectAndResume is a no-op. Cleared by `#resume`'s
	// finally block so a failed resume doesn't permanently lock the DO.
	#resumePromise: Promise<void> | null = null;
	// Debounce handle for mid-stream content/thinking/parts persistence.
	// When a DO eviction occurs, the persisted row is at most ~500ms behind
	// the live `#inProgress` mirror, so resume picks up close to where the
	// stream died.
	#flushTimer: ReturnType<typeof setTimeout> | null = null;
	// Cached conversation id (lazily loaded from `_meta`). Needed by resume
	// flows that aren't initiated by an HTTP request — the constructor runs
	// before any RPC, so we have to look it up from storage.
	#conversationId: string | null = null;
	// Per-DO ConversationContext cache. Cleared on TTL expiry.
	#contextCache: { fetchedAt: number; context: ConversationContext } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.#runMigrations();
			// If the DO was evicted mid-generation, leave the row as `streaming`
			// and schedule a near-future alarm. The alarm handler picks up
			// where the dead generation left off so the user doesn't have to
			// retry. Resume also runs lazily on `subscribe` / `addUserMessage`;
			// the alarm is a backstop for the no-traffic case.
			const interrupted = this.#sql.exec("SELECT id FROM messages WHERE status = 'streaming' LIMIT 1").toArray() as unknown as Array<{
				id: string;
			}>;
			if (interrupted.length > 0) {
				await ctx.storage.setAlarm(Date.now() + 200);
			}
		});
	}

	// Cloudflare invokes this when a previously-set alarm fires. Used as the
	// no-traffic backstop for resume — see the constructor's comment.
	async alarm(): Promise<void> {
		await this.#detectAndResume();
	}

	// Migrations are applied in order, once each, gated by the `_meta` table's
	// `schema_version` row. Adding a migration:
	//   1. Append a new entry to MIGRATIONS with the next version number.
	//   2. Don't edit existing entries — DOs already at version N skip them.
	//   3. The numeric version is the source of truth; the comments are just
	//      for humans.
	#runMigrations(): void {
		this.#sql.exec(`
			CREATE TABLE IF NOT EXISTS _meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
		`);
		const row = this.#sql.exec("SELECT value FROM _meta WHERE key = 'schema_version'").toArray() as unknown as Array<{ value: string }>;
		const current = row[0] ? Number.parseInt(row[0].value, 10) || 0 : 0;
		for (const m of MIGRATIONS) {
			if (m.version <= current) continue;
			m.up(this.#sql);
			this.#sql.exec(
				"INSERT INTO _meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
				String(m.version),
			);
		}
	}

	// `_meta` is a key/value table populated by migration 1. We piggy-back
	// `'conversation_id'` onto it so resume flows that aren't initiated by an
	// HTTP request (constructor / alarm) can find the conversation id without
	// reverse-decoding `ctx.id` (which isn't possible — `idFromName` is
	// one-way).
	#getConversationId(): string | null {
		if (this.#conversationId) return this.#conversationId;
		const row = this.#sql.exec("SELECT value FROM _meta WHERE key = 'conversation_id'").toArray() as unknown as Array<{ value: string }>;
		this.#conversationId = row[0]?.value ?? null;
		return this.#conversationId;
	}

	#setConversationId(id: string): void {
		if (this.#conversationId === id) return;
		this.#sql.exec(
			"INSERT INTO _meta (key, value) VALUES ('conversation_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			id,
		);
		this.#conversationId = id;
	}

	// Schedule a debounced write of the in-flight assistant row's
	// content/thinking/parts. Reduces the volume of state lost to a DO
	// eviction from "everything since end-of-tool" to "at most 500ms".
	#scheduleFlush(): void {
		if (this.#flushTimer || !this.#inProgress) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = null;
			this.#flushNow();
		}, 500);
	}

	#flushNow(): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		const ip = this.#inProgress;
		if (!ip) return;
		this.#sql.exec(
			'UPDATE messages SET content = ?, thinking = ?, parts = ? WHERE id = ?',
			ip.content,
			ip.thinking || null,
			ip.parts.length > 0 ? JSON.stringify(ip.parts) : null,
			ip.messageId,
		);
	}

	#cancelFlush(): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
	}

	// Detect a streaming row left behind by a previous activation and resume
	// its generation. Idempotent: if a resume is already in flight, or the DO
	// is already mid-generation (live `#inProgress`), this is a no-op. Safe
	// to call from constructor (via alarm), `subscribe`, and
	// `addUserMessage`.
	async #detectAndResume(): Promise<void> {
		if (this.#resumePromise || this.#inProgress) return;
		const rows = this.#sql
			.exec("SELECT id, model FROM messages WHERE status = 'streaming' ORDER BY created_at ASC")
			.toArray() as unknown as Array<{ id: string; model: string | null }>;
		if (rows.length === 0) return;

		// Defensive: if more than one streaming row exists (shouldn't happen
		// because addUserMessage gates on `#inProgress`), keep the newest and
		// stamp the older ones as error.
		if (rows.length > 1) {
			for (let i = 0; i < rows.length - 1; i++) {
				this.#sql.exec(
					"UPDATE messages SET status = 'error', error = ? WHERE id = ?",
					'Multiple streaming rows detected during resume.',
					rows[i].id,
				);
			}
		}
		const target = rows[rows.length - 1];
		const messageId = target.id;
		const model = target.model;
		if (!model) {
			this.#sql.exec("UPDATE messages SET status = 'error', error = ? WHERE id = ?", 'Cannot resume generation: model unknown.', messageId);
			this.#broadcast('refresh', {});
			return;
		}

		const conversationId = this.#getConversationId();
		if (!conversationId) {
			this.#sql.exec(
				"UPDATE messages SET status = 'error', error = ? WHERE id = ?",
				'Cannot resume generation: conversation id unknown.',
				messageId,
			);
			this.#broadcast('refresh', {});
			return;
		}

		// Hydrate `#inProgress` from the persisted row. Trim any trailing
		// partial text/thinking (those followed the last completed tool round
		// and were unflushed when the DO died) and normalize any orphan
		// tool_use blocks so the LLM history is valid.
		const row = this.#sql.exec('SELECT parts FROM messages WHERE id = ?', messageId).toArray() as unknown as Array<{
			parts: string | null;
		}>;
		const persistedParts = parseJson<MessagePart[]>(row[0]?.parts ?? null) ?? [];
		const trimmed = trimTrailingPartialOutput(persistedParts);
		normalizeParts(trimmed, 'Generation interrupted by Durable Object restart; retrying.');

		this.#sql.exec(
			"UPDATE messages SET content = '', thinking = NULL, parts = ?, started_at = ? WHERE id = ?",
			trimmed.length > 0 ? JSON.stringify(trimmed) : null,
			nowMs(),
			messageId,
		);

		this.#inProgress = {
			messageId,
			content: '',
			thinking: '',
			parts: trimmed,
			abortController: new AbortController(),
			startedAt: 0,
			firstTokenAt: 0,
			lastChunk: null,
			usage: null,
			providerID: null,
		};
		this.#broadcast('refresh', {});

		this.#resumePromise = this.#resume(conversationId, messageId, model);
		this.ctx.waitUntil(this.#resumePromise);
	}

	async #resume(conversationId: string, assistantId: string, model: string): Promise<void> {
		try {
			await this.#generate(conversationId, assistantId, model);
		} finally {
			this.#resumePromise = null;
		}
	}

	// Convert a recovered `parts` timeline into the `assistant` + `tool` Message
	// pairs the LLM expects, so a resumed generation sees the work that was
	// already done. Mirrors the in-loop construction at the tool execution
	// site — the persisted `parts` array uses the same shape the live array
	// does, but the LLM API expects them split across `assistant` (with
	// tool_use blocks) and `tool` (with tool_result blocks) messages, with
	// rounds alternating.
	#partsToMessages(parts: MessagePart[]): Message[] {
		const out: Message[] = [];
		let asstBlocks: ContentBlock[] = [];
		let toolBlocks: ContentBlock[] = [];
		const flushAssistant = () => {
			if (asstBlocks.length > 0) {
				out.push({ role: 'assistant', content: asstBlocks });
				asstBlocks = [];
			}
		};
		const flushTool = () => {
			if (toolBlocks.length > 0) {
				out.push({ role: 'tool', content: toolBlocks });
				toolBlocks = [];
			}
		};
		for (const p of parts) {
			if (p.type === 'text') {
				flushTool();
				asstBlocks.push({ type: 'text', text: p.text });
			} else if (p.type === 'thinking') {
				flushTool();
				asstBlocks.push({ type: 'thinking', text: p.text });
			} else if (p.type === 'tool_use') {
				flushTool();
				asstBlocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input, thoughtSignature: p.thoughtSignature });
			} else if (p.type === 'tool_result') {
				flushAssistant();
				toolBlocks.push({
					type: 'tool_result',
					toolUseId: p.toolUseId,
					content: p.content,
					...(p.isError ? { isError: true } : {}),
				});
			}
			// `info` parts are UI-only; skip.
		}
		flushAssistant();
		flushTool();
		return out;
	}

	getState(): ConversationState {
		const messages = this.#readMessages();
		if (this.#inProgress) {
			const ip = this.#inProgress;
			const merged = messages.map((m) =>
				m.id === ip.messageId
					? {
							...m,
							content: ip.content,
							thinking: ip.thinking || m.thinking,
							parts: ip.parts.length > 0 ? ip.parts.slice() : m.parts,
						}
					: m,
			);
			return { messages: merged, inProgress: { messageId: ip.messageId, content: ip.content } };
		}
		return { messages, inProgress: null };
	}

	async addUserMessage(conversationId: string, content: string, model: string): Promise<AddMessageResult> {
		this.#setConversationId(conversationId);
		// If a previous activation died mid-generation, resume that turn
		// before accepting the new message. The user wouldn't have hit "send"
		// if the prior generation was already complete, so this is mostly a
		// safety net for edge cases where the page reloaded just as the user
		// typed the next message.
		await this.#detectAndResume();
		if (this.#inProgress || this.#resumePromise) return { status: 'busy' };
		const trimmed = content.trim();
		if (!trimmed) return { status: 'invalid', reason: 'empty' };
		if (!model) return { status: 'invalid', reason: 'missing model' };

		const now = nowMs();
		const userId = uuid();
		const assistantId = uuid();

		// Pre-render the user message so the page load doesn't have to.
		let userContentHtml: string | null = null;
		try {
			userContentHtml = await renderMarkdown(trimmed);
		} catch {
			/* SSR will re-render on demand */
		}
		this.#sql.exec(
			"INSERT INTO messages (id, role, content, content_html, model, status, created_at) VALUES (?, 'user', ?, ?, NULL, 'complete', ?)",
			userId,
			trimmed,
			userContentHtml,
			now,
		);
		this.#sql.exec(
			"INSERT INTO messages (id, role, content, model, status, created_at) VALUES (?, 'assistant', '', ?, 'streaming', ?)",
			assistantId,
			model,
			now + 1,
		);

		this.#inProgress = {
			messageId: assistantId,
			content: '',
			thinking: '',
			parts: [],
			abortController: new AbortController(),
			startedAt: 0,
			firstTokenAt: 0,
			lastChunk: null,
			usage: null,
			providerID: null,
		};

		await this.#touchConversation(conversationId, trimmed);
		this.#broadcast('refresh', {});

		this.ctx.waitUntil(this.#generate(conversationId, assistantId, model));
		return { status: 'started' };
	}

	async regenerateTitle(conversationId: string): Promise<void> {
		this.#setConversationId(conversationId);
		const history = this.#sql
			.exec(`SELECT role, content FROM messages WHERE ${COMPLETE_PREDICATE} ORDER BY created_at ASC`)
			.toArray() as unknown as Array<{ role: string; content: string }>;
		const transcript = history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
		await this.#writeTitle(conversationId, transcript.slice(0, 4000), {
			systemPrompt:
				'You are a title generator. Given a conversation transcript, generate a short, clear, descriptive title (2-6 words) that summarises the overall topic or intent. Reply with the title only — no quotes, no explanation.',
			onlyIfDefault: false,
		});
		this.#broadcast('refresh', {});
	}

	async setThinkingBudget(conversationId: string, budget: number | null): Promise<void> {
		this.#setConversationId(conversationId);
		// Per-conversation thinking token budget. AnthropicLLM honors this when
		// the model supports extended thinking; OpenRouterLLM ignores it.
		const value = budget != null && budget > 0 ? Math.floor(budget) : null;
		await this.env.DB.prepare('UPDATE conversations SET thinking_budget = ? WHERE id = ?').bind(value, conversationId).run();
	}

	async abortGeneration(conversationId: string): Promise<void> {
		this.#setConversationId(conversationId);
		if (!this.#inProgress) return;
		const ip = this.#inProgress;
		// Cancel any pending debounced flush — we're about to write the
		// canonical final state for this row, and a stale flush landing
		// after it would resurrect status='streaming'.
		this.#cancelFlush();
		// Cancel the underlying provider stream + any in-flight tool. The
		// adapters and tools forward `signal` into their `fetch` calls, so the
		// connection drops without waiting on the next chunk.
		try {
			ip.abortController.abort('user');
		} catch {
			/* ignore */
		}
		// If a tool was in flight when abort fired, parts has a tool_use without
		// its matching result. Synthesize an error result so future turns don't
		// reject the history with an unmatched tool_use.
		normalizeParts(ip.parts, 'Aborted by user before this tool completed.');
		this.#sql.exec(
			`UPDATE messages SET content = ?, status = 'complete', thinking = ?, parts = ?, started_at = ?, first_token_at = ?, last_chunk_json = ?, usage_json = ?, provider = ? WHERE id = ?`,
			ip.content,
			ip.thinking || null,
			ip.parts.length > 0 ? JSON.stringify(ip.parts) : null,
			ip.startedAt || null,
			ip.firstTokenAt || null,
			ip.lastChunk ? JSON.stringify(ip.lastChunk) : null,
			ip.usage ? JSON.stringify(ip.usage) : null,
			ip.providerID,
			ip.messageId,
		);
		this.#inProgress = null;
		this.#broadcast('refresh', {});
	}

	async compactContext(conversationId: string): Promise<{ compacted: boolean; droppedCount: number }> {
		this.#setConversationId(conversationId);
		if (this.#inProgress || this.#resumePromise) return { compacted: false, droppedCount: 0 };

		const lastModelRow = this.#sql
			.exec(`SELECT model FROM messages WHERE role = 'assistant' AND ${COMPLETE_PREDICATE} ORDER BY created_at DESC LIMIT 1`)
			.toArray() as unknown as Array<{ model: string | null }>;
		const model = lastModelRow[0]?.model;
		if (!model) return { compacted: false, droppedCount: 0 };

		const history = this.#sql
			.exec(`SELECT id, role, content, parts FROM messages WHERE ${COMPLETE_PREDICATE} ORDER BY created_at ASC`)
			.toArray() as unknown as Array<{ id: string; role: string; content: string; parts: string | null }>;

		// Build LLM message array while tracking which DB row ID each LLM message came from.
		const rowIdAtLLMIndex: string[] = [];
		const messages: Message[] = [];
		for (const row of history) {
			if (row.role === 'assistant') {
				const parsedParts = parseJson<MessagePart[]>(row.parts) ?? [];
				const hasToolParts = parsedParts.some((p) => p.type === 'tool_use' || p.type === 'tool_result');
				if (hasToolParts) {
					const converted = this.#partsToMessages(parsedParts);
					for (const _ of converted) rowIdAtLLMIndex.push(row.id);
					messages.push(...converted);
				} else {
					rowIdAtLLMIndex.push(row.id);
					messages.push({ role: 'assistant', content: row.content });
				}
			} else if (row.role === 'user') {
				rowIdAtLLMIndex.push(row.id);
				messages.push({ role: 'user', content: row.content });
			}
		}

		const compaction = await compactHistory(messages, model, this.env, null, {}, true);
		if (!compaction.wasCompacted || !compaction.summary) return { compacted: false, droppedCount: 0 };

		// Map dropped LLM message count to DB row IDs to soft-delete.
		const rowsToDelete = new Set<string>();
		let llmCount = 0;
		for (const rowId of rowIdAtLLMIndex) {
			if (llmCount >= compaction.droppedCount) break;
			rowsToDelete.add(rowId);
			llmCount++;
		}

		const now = nowMs();
		for (const id of rowsToDelete) {
			this.#sql.exec('UPDATE messages SET deleted_at = ? WHERE id = ?', now, id);
		}

		// Insert a visible info message summarising what was compacted.
		const summaryId = uuid();
		const infoPart: MessagePart = {
			type: 'info',
			text: `Context compacted: summarized ${rowsToDelete.size} earlier messages. Summary: ${compaction.summary}`,
		};
		this.#sql.exec(
			"INSERT INTO messages (id, role, content, model, status, parts, created_at) VALUES (?, 'assistant', ?, ?, 'complete', ?, ?)",
			summaryId,
			compaction.summary,
			model,
			JSON.stringify([infoPart]),
			now + 1,
		);

		this.#broadcast('refresh', {});
		return { compacted: true, droppedCount: rowsToDelete.size };
	}

	// Wipe all DO storage. Cloudflare doesn't expose a "delete this DO from
	// the namespace" API, but `ctx.storage.deleteAll()` drops every row in
	// the SQLite store, so the next time something resolves this DO id it'll
	// be a fresh, empty instance. Pair with `deleteConversation()` in D1 to
	// fully evict a conversation. Closes any live SSE subscribers first so
	// they don't keep streaming on an already-vanished conversation.
	async destroy(): Promise<void> {
		this.#inProgress = null;
		this.#cancelFlush();
		this.#conversationId = null;
		for (const sub of this.#subscribers) {
			try {
				sub.controller.close();
			} catch {
				/* ignore */
			}
		}
		this.#subscribers.clear();
		this.#stopPingIfEmpty();
		await this.ctx.storage.deleteAll();
		// Tear down the conversation's sandbox container (best-effort).
		if (this.env.SANDBOX) {
			try {
				const sandbox = getSandbox(this.env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, this.ctx.id.toString());
				await sandbox.destroy();
			} catch {
				/* ignore */
			}
		}
	}

	async subscribe(): Promise<ReadableStream<Uint8Array>> {
		let storedSub: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number } | null = null;
		const self = this;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				storedSub = { controller, nextId: 1 };
				self.#subscribers.add(storedSub);
				self.#startPingIfNeeded();
				// Tell the browser to wait 3s before reconnecting on a dropped
				// connection, and send the current snapshot so the client can
				// resume without a full page reload.
				controller.enqueue(self.#encoder.encode('retry: 3000\n\n'));
				self.#sendSync(storedSub);
			},
			cancel() {
				if (storedSub) self.#subscribers.delete(storedSub);
				self.#stopPingIfEmpty();
			},
		});

		// If a previous activation died mid-generation, resume now that a
		// client is here to watch. The resume's broadcast events will reach
		// the new subscriber via the normal `#broadcast` path.
		void this.#detectAndResume();

		return stream;
	}

	#sendSync(sub: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number }): void {
		const messages = this.#readMessages();
		const last = messages[messages.length - 1];
		if (!last) return;
		const isInProgress = this.#inProgress?.messageId === last.id;
		const content = isInProgress ? this.#inProgress!.content : last.content;
		// Send the live timeline along with content so a subscriber that
		// reconnects mid-stream can replace its (possibly empty) parts list
		// with the server-side truth before any subsequent deltas arrive.
		// Without this, the first delta after reconnect would seed `parts`
		// from scratch and the renderer would drop the SSR'd content.
		const parts = isInProgress ? this.#inProgress!.parts.slice() : (last.parts ?? null);
		const thinking = isInProgress ? this.#inProgress!.thinking : (last.thinking ?? null);
		this.#enqueueTo(sub, 'sync', {
			lastMessageId: last.id,
			lastMessageStatus: last.status,
			lastMessageContent: content,
			lastMessageParts: parts,
			lastMessageThinking: thinking,
		});
	}

	// Tests inject a fake LLM via this RPC call so they can drive `#generate`
	// (and compaction, which routes through the same seam) deterministically
	// without hitting a real provider. Each entry in `script` is one turn's
	// worth of `StreamEvent`s; `chat()` shifts a turn per call. `null`
	// restores the real `routeLLM`. Production never touches this.
	//
	// Title generation has its own queue so a `__setLLMOverride([oneTurn])`
	// in a test isn't pulled by the title-gen background task.
	__llmOverrideScript: StreamEvent[][] | null = null;
	__titleLLMOverrideScript: StreamEvent[][] | null = null;
	// Tests can inspect what the DO sent to the override LLM (e.g. assert
	// the resumed turn included recovered tool history). Filled in by
	// `#routeLLM` while the override is active.
	__llmOverrideCalls: ChatRequest[] = [];
	__titleLLMOverrideCalls: ChatRequest[] = [];

	async __setLLMOverride(script: StreamEvent[][] | null): Promise<void> {
		this.__llmOverrideScript = script ? script.map((events) => events.slice()) : null;
		this.__llmOverrideCalls = [];
	}

	async __setTitleLLMOverride(script: StreamEvent[][] | null): Promise<void> {
		this.__titleLLMOverrideScript = script ? script.map((events) => events.slice()) : null;
		this.__titleLLMOverrideCalls = [];
	}

	async #routeLLM(
		globalId: string,
		opts: { purpose?: 'main' | 'title' } = {},
	): Promise<{ model: string; providerID: string; chat(req: ChatRequest): AsyncIterable<StreamEvent> }> {
		const isTitle = opts.purpose === 'title';
		const script = isTitle ? this.__titleLLMOverrideScript : this.__llmOverrideScript;
		if (script) {
			const calls = isTitle ? this.__titleLLMOverrideCalls : this.__llmOverrideCalls;
			return {
				model: globalId,
				providerID: 'fake',
				async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
					calls.push(req);
					const turn = script.shift();
					if (!turn) {
						yield { type: 'error', message: 'FakeLLM: ran out of scripted turns' };
						return;
					}
					for (const ev of turn) yield ev;
				},
			};
		}
		const resolved = await getResolvedModel(this.env, globalId);
		if (!resolved) throw new Error(`Unknown model: ${globalId}`);
		const llm = routeLLM(resolved.provider, resolved.model);
		return {
			model: globalId,
			providerID: resolved.provider.id,
			chat: (req) => llm.chat(req),
		};
	}

	async #generate(conversationId: string, assistantId: string, model: string): Promise<void> {
		const ip = this.#inProgress!;
		ip.startedAt = nowMs();

		// Live mirror of the turn lives on `this.#inProgress.parts` so a
		// resubscribing client can pick up the timeline as it stands. We
		// alias it locally for readability.
		const parts = ip.parts;
		const signal = ip.abortController.signal;
		// `parts` is the canonical timeline. Citations don't have a place in
		// the parts shape (they're surfaced separately to the UI), so we
		// accumulate them as the loop runs.
		const accumulatedCitations: ToolCitation[] = [];
		const appendText = (delta: string) => {
			const last = parts[parts.length - 1];
			if (last && last.type === 'text') {
				last.text += delta;
			} else {
				parts.push({ type: 'text', text: delta });
			}
		};
		const appendThinking = (delta: string) => {
			const last = parts[parts.length - 1];
			if (last && last.type === 'thinking') {
				last.text += delta;
			} else {
				parts.push({ type: 'thinking', text: delta });
			}
		};

		this.#sql.exec('UPDATE messages SET started_at = ? WHERE id = ?', ip.startedAt, assistantId);

		try {
			let currentModel = model;
			let llm = await this.#routeLLM(model);
			const history = this.#sql
				.exec(`SELECT role, content, parts FROM messages WHERE id != ? AND ${COMPLETE_PREDICATE} ORDER BY created_at ASC`, assistantId)
				.toArray() as unknown as Array<{ role: string; content: string; parts: string | null }>;
			let messages: Message[] = [];
			for (const m of history) {
				if (m.role === 'assistant') {
					const parsedParts = parseJson<MessagePart[]>(m.parts) ?? [];
					const hasToolParts = parsedParts.some((p) => p.type === 'tool_use' || p.type === 'tool_result');
					if (hasToolParts) {
						messages.push(...this.#partsToMessages(parsedParts));
					} else {
						messages.push({ role: 'assistant', content: m.content });
					}
				} else {
					messages.push({ role: 'user', content: m.content });
				}
			}

			// Resume case: if `parts` was hydrated from a persisted row that
			// contains completed tool rounds, the LLM needs to see those
			// tool_use/tool_result pairs so it continues from after them
			// instead of redoing the work. Splice them in as synthetic prior
			// assistant + tool messages.
			const recoveredHasTools = parts.some((p) => p.type === 'tool_use' || p.type === 'tool_result');
			if (recoveredHasTools) {
				messages.push(...this.#partsToMessages(parts));
			}

			// Check whether we need to compact context before sending. The
			// `usage_json` column has held the canonical `Usage` shape
			// (`inputTokens`/`cacheReadInputTokens`) since round 1; the older
			// OpenRouter-style `{promptTokens, promptTokensDetails}` shape is
			// kept as a fallback for legacy rows.
			const lastUsageRow = this.#sql
				.exec(`SELECT usage_json FROM messages WHERE role = 'assistant' AND ${COMPLETE_PREDICATE} ORDER BY created_at DESC LIMIT 1`)
				.toArray() as unknown as Array<{ usage_json: string | null }>;
			const lastUsage = lastUsageRow[0]?.usage_json
				? (parseJson<{
						inputTokens?: number;
						cacheReadInputTokens?: number;
						promptTokens?: number;
						promptTokensDetails?: { cachedTokens?: number };
					}>(lastUsageRow[0].usage_json) ?? null)
				: null;
			const usageForCompaction = lastUsage
				? {
						inputTokens: lastUsage.inputTokens ?? lastUsage.promptTokens ?? 0,
						cacheReadInputTokens:
							lastUsage.cacheReadInputTokens ?? lastUsage.promptTokensDetails?.cachedTokens,
					}
				: null;
			const compaction = await compactHistory(messages, model, this.env, usageForCompaction, {
				llm: (_env, id) => this.#routeLLM(id) as unknown as Promise<LLM>,
			});
			if (compaction.wasCompacted) {
				const infoPart: MessagePart = {
					type: 'info',
					text: `Context compacted: summarized ${compaction.droppedCount} earlier messages to stay within the model's limit.`,
				};
				parts.push(infoPart);
				this.#sql.exec('UPDATE messages SET parts = ? WHERE id = ?', JSON.stringify(parts), assistantId);
				this.#broadcast('part', { messageId: assistantId, part: infoPart });
				messages = compaction.messages;
			}

			const DEFAULT_SYSTEM_PROMPT = `You are **Interface**, an AI agent that bridges users and complex computer systems. You have access to tools for interacting with external services (YNAB, the web, documentation sources, sub-agents, etc.) and you use them proactively to give grounded, accurate answers rather than guessing.

## Core operating principles

**Verify, don't assume.** Your training data is stale and your memory is fallible. When a user asks about facts, current events, product specs, API behavior, or anything else that could have changed or that you're not certain about, use ${'`'}web_search${'`'}, ${'`'}fetch_url${'`'}, or the documentation tools to check. Cite sources when you're relaying factual claims from the web.

**Treat sources critically.** People on the internet lie, get things wrong, or have agendas. Prefer primary sources, official docs, and reputable outlets. When sources conflict, say so.

**Use tools in parallel when you can.** If multiple tool calls are independent, batch them in a single function-calls block. Only serialize when a later call genuinely depends on an earlier result — never use placeholder values or guesses for required parameters.

**Ask before guessing required parameters.** If a tool needs a value you can't reasonably infer from context, ask the user. Don't fabricate. Optional parameters you can leave alone unless they're clearly useful.

**Respect exact values.** When the user quotes a specific value (an ID, a string, a number), use it verbatim.

**Delegate when it helps.** For focused research or work that would clutter the main thread, consider the ${'`'}agent${'`'} tool — but always confirm the model with the user first (via ${'`'}get_models${'`'}) unless they've already picked one this conversation.

## Style and tone

Talk to the user casually, like a friend chatting — but don't pretend to be human. You're a computer, and it's fine (good, even) to be upfront about that. Skip corporate hedging, unnecessary disclaimers, and moralizing. If something's uncertain, say it's uncertain; if something's wrong, say so directly.

Be concise by default. Expand when the task genuinely calls for depth (design docs, research writeups, code with explanation). Don't pad answers with recaps of what the user just said.

**Personality.** You're dry, a little wry, and allergic to corporate cheerfulness. You have opinions and you share them when asked — if a user floats a bad idea, say so and explain why, don't just nod along. You find computers genuinely interesting (the weird historical corners especially) and it's fine to let that show when it's relevant. You don't do forced enthusiasm, exclamation points as punctuation filler, or "Great question!" preambles. You don't apologize unless you actually broke something. When you're uncertain, you say "I'm not sure" instead of hedging with six qualifiers. You're comfortable with silence — if the answer is one sentence, it's one sentence. You treat the user as a competent adult who can handle being disagreed with, being told they're wrong, or being told a task is going to be annoying. Swearing is fine in moderation when it fits the moment. You're a computer, not a butler and not a friend pretending to be a therapist; you're the sharp, slightly sardonic coworker who actually knows the system and will tell you the truth about it.

## About the user

The user's bio, preferences, and context are provided separately in the user turn. Use that context when it's actually relevant to the task — don't surface personal details just to demonstrate that you remember them.`;

			const [context, convoRow] = await Promise.all([
				this.#getContext(),
				this.env.DB.prepare('SELECT thinking_budget FROM conversations WHERE id = ?')
					.bind(conversationId)
					.first<{ thinking_budget: number | null }>(),
			]);
			const thinkingBudget = convoRow?.thinking_budget ?? null;

			// Resolve the routed model from the cached models list rather than
			// hitting D1 again. `getResolvedModel`'s D1 reads happen inside
			// `#routeLLM`, so the route already has the provider+model bytes
			// in flight.
			const resolved: ResolvedModel | null = await getResolvedModel(this.env, model);
			const reasoningType = resolved?.model.reasoningType ?? null;
			const providerType = resolved?.provider.type ?? null;

			let reasoning: ReasoningConfig | undefined;
			let thinking: ChatRequest['thinking'] | undefined;

			// Translate the per-conversation thinking budget into the right
			// provider shape. Native Anthropic uses the legacy `thinking`
			// field; everything else uses `reasoning`. Only one is set so
			// AnthropicLLM never has to disambiguate.
			const isNativeAnthropic = providerType === 'anthropic';
			if (thinkingBudget != null && thinkingBudget > 0) {
				if (isNativeAnthropic) {
					thinking = { type: 'enabled', budgetTokens: thinkingBudget };
				} else if (reasoningType === 'effort') {
					const effort = budgetToEffort(thinkingBudget);
					if (effort) reasoning = { type: 'effort', effort };
				} else if (reasoningType === 'max_tokens') {
					reasoning = { type: 'max_tokens', maxTokens: thinkingBudget };
				}
			}

			const COMPATIBILITY_NOTE =
				'Your output is rendered in a UI that uses KaTeX for math typesetting. Dollar signs ($) are treated as LaTeX math delimiters, so be careful with dollar signs in non-math contexts (e.g. prices, currency). To include a literal dollar sign, escape it as \\$.';
			const effectiveSystemPrompt = context.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
			const systemPrompt = context.userBio
				? `${effectiveSystemPrompt}\n\n${COMPATIBILITY_NOTE}\n\nUser bio:\n${context.userBio}`
				: `${effectiveSystemPrompt}\n\n${COMPATIBILITY_NOTE}`;

			const registry = await this.#buildToolRegistry(model, context);
			const tools: ToolDefinition[] | undefined = registry.definitions().length > 0 ? registry.definitions() : undefined;

			ip.providerID = llm.providerID;
			let hitIterationCap = false;
			for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
				const turnToolCalls: RecordedToolCall[] = [];
				let turnText = '';
				let providerError: string | null = null;
				const isLastIteration = iteration === MAX_TOOL_ITERATIONS - 1;

				for await (const ev of llm.chat({
					messages,
					systemPrompt,
					signal,
					...(tools ? { tools } : {}),
					...(thinking ? { thinking } : {}),
					...(reasoning ? { reasoning } : {}),
				})) {
					if (!this.#inProgress || this.#inProgress.messageId !== assistantId) break;
					if (ev.type === 'text_delta') {
						if (!ip.firstTokenAt) ip.firstTokenAt = nowMs();
						turnText += ev.delta;
						appendText(ev.delta);
						ip.content += ev.delta;
						this.#broadcast('delta', { messageId: assistantId, content: ev.delta });
						this.#scheduleFlush();
					} else if (ev.type === 'thinking_delta') {
						ip.thinking += ev.delta;
						appendThinking(ev.delta);
						this.#broadcast('thinking_delta', { messageId: assistantId, content: ev.delta });
						this.#scheduleFlush();
					} else if (ev.type === 'tool_call') {
						turnToolCalls.push({ id: ev.id, name: ev.name, input: ev.input, thoughtSignature: ev.thoughtSignature });
					} else if (ev.type === 'usage') {
						ip.usage = ev.usage;
					} else if (ev.type === 'done') {
						if (ev.raw && typeof ev.raw === 'object') {
							ip.lastChunk = ev.raw;
						}
					} else if (ev.type === 'error') {
						providerError = ev.message;
					}
				}

				if (!this.#inProgress || this.#inProgress.messageId !== assistantId) break;

				if (providerError) throw new Error(providerError);

				if (turnToolCalls.length === 0) break;

				// Build the assistant message that triggered these tool calls.
				const assistantBlocks: ContentBlock[] = [];
				if (turnText) assistantBlocks.push({ type: 'text', text: turnText });
				for (const tc of turnToolCalls) {
					assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input, thoughtSignature: tc.thoughtSignature });
				}
				messages.push({ role: 'assistant', content: assistantBlocks });

				// Execute each tool, broadcast call+result events, append result to history.
				// We push the `tool_use` and a preliminary streaming `tool_result`
				// to the parts mirror BEFORE execute so an abort mid-execution
				// always sees a paired pair. The preliminary part is swapped for
				// the final result on completion, and a streaming
				// `emitToolOutput` callback streams output chunks to the UI.
				let pendingModelSwitch: string | null = null;
				for (const call of turnToolCalls) {
					if (!this.#inProgress || this.#inProgress.messageId !== assistantId) break;
					parts.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input, thoughtSignature: call.thoughtSignature });
					this.#broadcast('tool_call', {
						messageId: assistantId,
						id: call.id,
						name: call.name,
						input: call.input,
						thoughtSignature: call.thoughtSignature,
					});
					// Seed a preliminary streaming tool_result so the UI shows the
					// call as active while output arrives. Replaced with the final
					// result once execution completes.
					parts.push({ type: 'tool_result', toolUseId: call.id, content: '', isError: false, streaming: true });
					this.#broadcast('tool_result', {
						messageId: assistantId,
						toolUseId: call.id,
						content: '',
						isError: false,
						streaming: true,
					});
					const result = await registry.execute(
						{
							env: this.env,
							conversationId,
							assistantMessageId: assistantId,
							signal,
							emitToolOutput: (chunk: string) => {
								this.#broadcast('tool_output', {
									messageId: assistantId,
									toolUseId: call.id,
									chunk,
								});
							},
							switchModel: (newModelId: string) => {
								pendingModelSwitch = newModelId;
							},
						},
						call.name,
						call.input,
					);
					// Swap the preliminary streaming part for the final result.
					const partsIdx = parts.findIndex((p) => p.type === 'tool_result' && p.toolUseId === call.id);
					if (partsIdx >= 0) {
						parts[partsIdx] = {
							type: 'tool_result',
							toolUseId: call.id,
							content: result.content,
							isError: result.isError ?? false,
						};
					} else {
						parts.push({
							type: 'tool_result',
							toolUseId: call.id,
							content: result.content,
							isError: result.isError ?? false,
						});
					}
					// Persist the running parts column each step so stream death
					// or DO eviction leaves a row that's still consistent. We
					// also need content/thinking flushed here so any debounced
					// delta flush isn't beaten to the row.
					this.#cancelFlush();
					this.#sql.exec(
						'UPDATE messages SET content = ?, thinking = ?, parts = ? WHERE id = ?',
						this.#inProgress!.content,
						this.#inProgress!.thinking || null,
						JSON.stringify(parts),
						assistantId,
					);
					if (result.citations) accumulatedCitations.push(...result.citations);
					if (result.artifacts) {
						for (const a of result.artifacts) {
							this.addArtifact({
								messageId: assistantId,
								type: a.type,
								name: a.name ?? null,
								language: a.language ?? null,
								content: a.content,
							});
						}
					}
					this.#broadcast('tool_result', {
						messageId: assistantId,
						toolUseId: call.id,
						content: result.content,
						isError: result.isError ?? false,
					});

					messages.push({
						role: 'tool',
						content: [
							{
								type: 'tool_result',
								toolUseId: call.id,
								content: result.content,
								...(result.isError ? { isError: true } : {}),
							},
						],
					});
				}

				if (pendingModelSwitch && pendingModelSwitch !== currentModel && this.#inProgress?.messageId === assistantId) {
					currentModel = pendingModelSwitch;
					llm = await this.#routeLLM(currentModel);
					ip.providerID = llm.providerID;
					const infoPart: MessagePart = { type: 'info', text: `Switched to model: ${currentModel}` };
					parts.push(infoPart);
					this.#sql.exec('UPDATE messages SET parts = ? WHERE id = ?', JSON.stringify(parts), assistantId);
					this.#broadcast('part', { messageId: assistantId, part: infoPart });
				}

				if (isLastIteration && this.#inProgress?.messageId === assistantId) {
					// We executed this iteration's tools but the loop is about to
					// exit, so the model never gets to respond to the results.
					// Surface that explicitly so the user knows why the answer
					// stops mid-flow.
					hitIterationCap = true;
					const infoPart: MessagePart = {
						type: 'info',
						text: `Tool iteration budget exhausted (${MAX_TOOL_ITERATIONS} rounds). The model did not produce a final answer; ask a follow-up to continue.`,
					};
					parts.push(infoPart);
					this.#broadcast('part', { messageId: assistantId, part: infoPart });
				}
			}
			void hitIterationCap;

			if (!this.#inProgress || this.#inProgress.messageId !== assistantId) {
				// Aborted by user — don't overwrite the row already persisted by abortGeneration.
				this.#cancelFlush();
				return;
			}
			// Cancel any pending debounced flush so a stale write doesn't land
			// after the canonical final UPDATE below resets status to complete.
			this.#cancelFlush();
			const finalText = this.#inProgress.content;
			const finalThinking = this.#inProgress.thinking;
			// Pre-render the heavy markdown / Shiki / KaTeX pipeline once at
			// generation completion so subsequent page loads don't re-render
			// every assistant message on every navigation. Best-effort: we
			// fall through to a null write if anything throws, and the SSR
			// path will re-render on demand.
			let contentHtml: string | null = null;
			let thinkingHtml: string | null = null;
			// Enrich text/thinking parts with `textHtml` so SSR doesn't have to
			// re-render on every load. The enriched parts replace the raw
			// `parts` column — one column, two read paths (live vs cached).
			let enrichedParts: MessagePart[] = parts;
			try {
				contentHtml = finalText ? await renderMarkdown(finalText) : null;
				thinkingHtml = finalThinking ? await renderMarkdown(finalThinking) : null;
				if (parts.length > 0) {
					enrichedParts = await Promise.all(
						parts.map(async (part) => {
							if (part.type === 'text' || part.type === 'thinking') {
								return { ...part, textHtml: await renderMarkdown(part.text) };
							}
							return part;
						}),
					);
				}
			} catch {
				/* fall back to live SSR re-rendering */
			}
			this.#sql.exec(
				`UPDATE messages SET content = ?, status = 'complete', first_token_at = ?, last_chunk_json = ?, usage_json = ?, provider = ?, thinking = ?, parts = ?, content_html = ?, thinking_html = ? WHERE id = ?`,
				finalText,
				ip.firstTokenAt || null,
				ip.lastChunk ? JSON.stringify(ip.lastChunk) : null,
				ip.usage ? JSON.stringify(ip.usage) : null,
				llm.providerID,
				finalThinking || null,
				enrichedParts.length > 0 ? JSON.stringify(enrichedParts) : null,
				contentHtml,
				thinkingHtml,
				assistantId,
			);
			this.#inProgress = null;
			await this.env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(nowMs(), conversationId).run();
			this.#broadcast('meta', {
				messageId: assistantId,
				snapshot: { startedAt: ip.startedAt, firstTokenAt: ip.firstTokenAt, lastChunk: ip.lastChunk, usage: ip.usage },
			});
			if (accumulatedCitations.length > 0) {
				this.#broadcast('citations', { messageId: assistantId, citations: accumulatedCitations });
			}
			this.#broadcast('refresh', {});
		} catch (e) {
			if (!this.#inProgress || this.#inProgress.messageId !== assistantId) {
				// Already aborted and cleaned up by abortGeneration.
				this.#cancelFlush();
				return;
			}
			this.#cancelFlush();
			const msg = formatError(e);
			const partial = this.#inProgress.content;
			this.#sql.exec(
				"UPDATE messages SET content = ?, status = 'error', error = ?, first_token_at = ?, last_chunk_json = ?, usage_json = ? WHERE id = ?",
				partial,
				msg,
				ip.firstTokenAt || null,
				ip.lastChunk ? JSON.stringify(ip.lastChunk) : null,
				ip.usage ? JSON.stringify(ip.usage) : null,
				assistantId,
			);
			this.#inProgress = null;
			this.#broadcast('refresh', {});
		}
	}

	// Per-turn snapshot of the static-ish D1 config (settings + sub-agents
	// + mcp servers + provider models). Cached per-DO with a 30s TTL so a
	// chat turn issues at most one round of fetches instead of ~10.
	async #getContext(): Promise<ConversationContext> {
		const cached = this.#contextCache;
		if (cached && nowMs() - cached.fetchedAt < CONTEXT_CACHE_TTL_MS) return cached.context;
		const [systemPrompt, userBio, allModels, subAgents, mcpServers] = await Promise.all([
			getSystemPrompt(this.env),
			getUserBio(this.env),
			listAllModels(this.env),
			listSubAgents(this.env),
			listMcpServers(this.env),
		]);
		const context: ConversationContext = { systemPrompt, userBio, allModels, subAgents, mcpServers };
		this.#contextCache = { fetchedAt: nowMs(), context };
		return context;
	}

	#invalidateContextCache(): void {
		this.#contextCache = null;
	}

	// Base registry — built-in tools + MCP. Used directly for the parent
	// loop (extended below with the `agent` tool) and re-built fresh per
	// sub-agent invocation as the inner tool set.
	async #buildBaseToolRegistry(mcpServers: McpServerRow[]): Promise<ToolRegistry> {
		const registry = new ToolRegistry();
		registry.register(fetchUrlTool);
		if (this.env.KAGI_KEY) {
			registry.register(createWebSearchTool(new KagiSearchBackend(this.env.KAGI_KEY)));
		}
		if (this.env.YNAB_TOKEN) {
			for (const tool of createYnabTools(this.env.YNAB_TOKEN)) {
				registry.register(tool);
			}
		}
		try {
			await Promise.all(
				mcpServers
					.filter((s) => s.enabled && (s.transport === 'http' || s.transport === 'sse') && s.url)
					.map((s) => this.#registerMcpServerTools(registry, s.id, s.name, s.url!, s.authJson)),
			);
		} catch {
			// MCP enumeration failures are best-effort.
		}
		if (this.env.SANDBOX) {
			registerSandboxTools(registry);
		}
		return registry;
	}

	async #buildToolRegistry(model: string, context: ConversationContext): Promise<ToolRegistry> {
		const registry = await this.#buildBaseToolRegistry(context.mcpServers);
		const globalIds = context.allModels.map((m) => buildGlobalModelId(m.providerId, m.id));
		if (globalIds.length > 0) {
			registry.register(createSwitchModelTool({ availableModelGlobalIds: globalIds }));
		}
		const enabledSubAgents = context.subAgents.filter((sa) => sa.enabled);
		if (enabledSubAgents.length > 0) {
			registry.register(createGetModelsTool({ currentModel: model, availableModels: context.allModels }));
			const agentTool = createAgentTool(
				{
					buildInnerToolRegistry: () => this.#buildBaseToolRegistry(context.mcpServers),
					defaultModel: model,
					availableModelGlobalIds: globalIds,
				},
				context.subAgents,
			);
			if (agentTool) registry.register(agentTool);
		}
		return registry;
	}

	async #registerMcpServerTools(
		registry: ToolRegistry,
		serverId: number,
		serverName: string,
		url: string,
		authJson: string | null,
	): Promise<void> {
		try {
			const cached = this.#mcpCache.get(serverId);
			const fresh = cached && nowMs() - cached.fetchedAt < MCP_TOOL_CACHE_TTL_MS;
			let entry: { fetchedAt: number; client: McpHttpClient; tools: import('../mcp/types').McpToolDescriptor[] };
			if (fresh && cached) {
				entry = cached;
			} else {
				const client = new McpHttpClient({ url, authJson });
				const tools = await client.listTools();
				entry = { fetchedAt: nowMs(), client, tools };
				this.#mcpCache.set(serverId, entry);
			}
			const callClient = entry.client;
			for (const tool of entry.tools) {
				const namespacedName = `mcp_${serverId}_${tool.name}`;
				registry.register({
					definition: {
						name: namespacedName,
						description: tool.description ?? `${serverName}: ${tool.name}`,
						inputSchema: tool.inputSchema ?? { type: 'object' },
					},
					async execute(_ctx, input) {
						try {
							const result = await callClient.callTool(tool.name, input);
							const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
							return { content: text, ...(result.isError ? { isError: true } : {}) };
						} catch (e) {
							return { content: e instanceof Error ? e.message : String(e), isError: true };
						}
					},
				});
			}
		} catch {
			// Server unreachable during enumeration — skip and try again next turn.
			this.#mcpCache.delete(serverId);
		}
	}

	#readMessages(): MessageRow[] {
		const rows = this.#sql
			.exec(
				`SELECT id, role, content, content_html, model, status, error, created_at, started_at, first_token_at, last_chunk_json, usage_json, thinking, thinking_html, parts
				 FROM messages
				 WHERE deleted_at IS NULL
				 ORDER BY created_at ASC`,
			)
			.toArray() as unknown as Array<{
			id: string;
			role: string;
			content: string;
			content_html: string | null;
			model: string | null;
			status: string;
			error: string | null;
			created_at: number;
			started_at: number | null;
			first_token_at: number | null;
			last_chunk_json: string | null;
			usage_json: string | null;
			thinking: string | null;
			thinking_html: string | null;
			parts: string | null;
		}>;
		const artifactsByMessage = this.#readArtifactsByMessage();
		return rows.map((r) => {
			const parts = parseJson<MessagePart[]>(r.parts) ?? [];
			return {
				id: r.id,
				role: r.role as 'user' | 'assistant',
				content: r.content,
				contentHtml: r.content_html,
				thinking: r.thinking,
				thinkingHtml: r.thinking_html,
				model: r.model,
				status: r.status as 'complete' | 'streaming' | 'error',
				error: r.error,
				createdAt: r.created_at,
				meta: this.#deriveMeta(r.started_at, r.first_token_at, r.last_chunk_json, r.usage_json),
				artifacts: artifactsByMessage.get(r.id) ?? [],
				parts,
			};
		});
	}

	#readArtifactsByMessage(): Map<string, Artifact[]> {
		const rows = this.#sql
			.exec(
				`SELECT id, message_id, type, name, language, version, content, content_html, created_at FROM artifacts ORDER BY created_at ASC`,
			)
			.toArray() as unknown as Array<{
			id: string;
			message_id: string;
			type: string;
			name: string | null;
			language: string | null;
			version: number;
			content: string;
			content_html: string | null;
			created_at: number;
		}>;
		const map = new Map<string, Artifact[]>();
		for (const r of rows) {
			const list = map.get(r.message_id) ?? [];
			list.push({
				id: r.id,
				messageId: r.message_id,
				type: r.type as ArtifactType,
				name: r.name,
				language: r.language,
				version: r.version,
				content: r.content,
				contentHtml: r.content_html,
				createdAt: r.created_at,
			});
			map.set(r.message_id, list);
		}
		return map;
	}

	async addArtifact(input: {
		messageId: string;
		type: ArtifactType;
		name?: string | null;
		language?: string | null;
		content: string;
	}): Promise<Artifact> {
		const id = uuid();
		const now = nowMs();
		const versionRow = this.#sql
			.exec('SELECT MAX(version) AS v FROM artifacts WHERE message_id = ?', input.messageId)
			.toArray() as unknown as Array<{ v: number | null }>;
		const version = (versionRow[0]?.v ?? 0) + 1;
		// Pre-render to HTML once at insert so SSR doesn't re-tokenise on every load.
		let contentHtml: string | null = null;
		try {
			if (input.type === 'code') {
				contentHtml = await renderArtifactCode(input.content, input.language ?? 'text');
			} else if (input.type === 'markdown') {
				contentHtml = await renderMarkdown(input.content);
			}
		} catch {
			/* SSR will re-render on demand */
		}
		this.#sql.exec(
			`INSERT INTO artifacts (id, message_id, type, name, language, version, content, content_html, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.messageId,
			input.type,
			input.name ?? null,
			input.language ?? null,
			version,
			input.content,
			contentHtml,
			now,
		);
		// Update artifact_ids on the parent message.
		const existing = this.#sql.exec('SELECT artifact_ids FROM messages WHERE id = ?', input.messageId).toArray() as unknown as Array<{
			artifact_ids: string | null;
		}>;
		let ids: string[] = [];
		if (existing[0]?.artifact_ids) {
			try {
				ids = JSON.parse(existing[0].artifact_ids) as string[];
			} catch {
				ids = [];
			}
		}
		ids.push(id);
		this.#sql.exec('UPDATE messages SET artifact_ids = ? WHERE id = ?', JSON.stringify(ids), input.messageId);

		const artifact: Artifact = {
			id,
			messageId: input.messageId,
			type: input.type,
			name: input.name ?? null,
			language: input.language ?? null,
			version,
			content: input.content,
			contentHtml,
			createdAt: now,
		};
		this.#broadcast('artifact', { artifact });
		return artifact;
	}

	#deriveMeta(
		startedAt: number | null,
		firstTokenAt: number | null,
		lastChunkJson: string | null,
		usageJson: string | null,
	): MetaSnapshot | null {
		if (!startedAt && !lastChunkJson && !usageJson) return null;
		let lastChunk: unknown | null = null;
		let usage: MetaSnapshot['usage'] = null;
		try {
			if (lastChunkJson) lastChunk = JSON.parse(lastChunkJson) as unknown;
		} catch {
			/* keep null */
		}
		try {
			if (usageJson) usage = JSON.parse(usageJson) as MetaSnapshot['usage'];
		} catch {
			/* keep null */
		}
		return {
			startedAt: startedAt ?? 0,
			firstTokenAt: firstTokenAt ?? 0,
			lastChunk,
			usage,
		};
	}

	async #touchConversation(conversationId: string, firstMessageContent: string): Promise<void> {
		const now = nowMs();
		// Always update the timestamp; the title update is handled separately
		// via waitUntil so it doesn't block the main flow.
		await this.env.DB.prepare(
			`UPDATE conversations
				SET updated_at = ?
				WHERE id = ?`,
		)
			.bind(now, conversationId)
			.run();

		// Generate the title asynchronously so it doesn't delay the response.
		this.ctx.waitUntil(this.#generateTitle(conversationId, firstMessageContent));
	}

	async #generateTitle(conversationId: string, firstMessageContent: string): Promise<void> {
		await this.#writeTitle(conversationId, firstMessageContent, {
			systemPrompt:
				'You are a title generator. Given the user message, generate a short, clear, descriptive title (2-6 words) that summarises its topic or intent. Reply with the title only — no quotes, no explanation.',
			onlyIfDefault: true,
		});
	}

	// Run the title-generator LLM, normalize its output, and persist to D1.
	// `onlyIfDefault` guards the auto-generated path so a user-edited title
	// isn't clobbered by a slow waitUntil() catching up. `regenerateTitle`
	// passes false because the user explicitly asked for a refresh.
	async #writeTitle(conversationId: string, input: string, opts: { systemPrompt: string; onlyIfDefault: boolean }): Promise<void> {
		const collapsed = input.replace(/\s+/g, ' ').trim();
		// Pick the configured title model, or fall back to the first available model.
		// Use the cached models list rather than hitting D1 again.
		const context = await this.#getContext();
		const globalIds = context.allModels.map((m) => buildGlobalModelId(m.providerId, m.id));
		const configuredTitleModel = await getSetting(this.env, 'title_model');
		const titleModel = configuredTitleModel && globalIds.includes(configuredTitleModel) ? configuredTitleModel : globalIds[0];
		if (!titleModel) return; // No models configured, skip title generation

		let title: string;
		try {
			const llm = await this.#routeLLM(titleModel, { purpose: 'title' });
			let buf = '';
			for await (const ev of llm.chat({
				messages: [
					{ role: 'system', content: opts.systemPrompt },
					{ role: 'user', content: collapsed },
				],
				maxTokens: 1024,
				temperature: 0.5,
			})) {
				if (ev.type === 'text_delta') buf += ev.delta;
				if (ev.type === 'error') throw new Error(ev.message);
			}
			title = buf.trim().replace(/^"|"$/g, '').slice(0, TITLE_MAX);
			if (!title) throw new Error('empty title from LLM');
		} catch {
			title = collapsed.length <= TITLE_MAX ? collapsed : collapsed.slice(0, TITLE_MAX).trimEnd() + '…';
		}
		const sql = opts.onlyIfDefault
			? `UPDATE conversations SET title = CASE WHEN title = 'New conversation' THEN ? ELSE title END WHERE id = ?`
			: 'UPDATE conversations SET title = ? WHERE id = ?';
		await this.env.DB.prepare(sql).bind(title, conversationId).run();
	}

	#sseFrame(event: string, data: unknown, id?: number): Uint8Array {
		const idLine = id != null ? `id: ${id}\n` : '';
		return this.#encoder.encode(`event: ${event}\n${idLine}data: ${JSON.stringify(data)}\n\n`);
	}

	#enqueueTo(sub: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number }, event: string, data: unknown): boolean {
		try {
			const id = sub.nextId++;
			sub.controller.enqueue(this.#sseFrame(event, data, id));
			return true;
		} catch {
			this.#subscribers.delete(sub);
			return false;
		}
	}

	#broadcast(event: string, data: unknown): void {
		if (this.#subscribers.size === 0) return;
		const dead: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number }[] = [];
		for (const sub of this.#subscribers) {
			try {
				const id = sub.nextId++;
				sub.controller.enqueue(this.#sseFrame(event, data, id));
			} catch {
				dead.push(sub);
			}
		}
		for (const c of dead) this.#subscribers.delete(c);
		this.#stopPingIfEmpty();
	}

	#startPingIfNeeded(): void {
		if (this.#pingInterval || this.#subscribers.size === 0) return;
		const frame = this.#encoder.encode(`: ping\n\n`);
		this.#pingInterval = setInterval(() => {
			if (this.#subscribers.size === 0) {
				this.#stopPingIfEmpty();
				return;
			}
			const dead: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number }[] = [];
			for (const sub of this.#subscribers) {
				try {
					sub.controller.enqueue(frame);
				} catch {
					dead.push(sub);
				}
			}
			for (const c of dead) this.#subscribers.delete(c);
			this.#stopPingIfEmpty();
		}, PING_INTERVAL_MS);
	}

	#stopPingIfEmpty(): void {
		if (this.#subscribers.size === 0 && this.#pingInterval) {
			clearInterval(this.#pingInterval);
			this.#pingInterval = null;
		}
	}
}

function budgetToEffort(budget: number): ReasoningEffort | null {
	if (budget <= 0) return null;
	if (budget <= 1024) return 'low';
	if (budget <= 4096) return 'medium';
	if (budget <= 16384) return 'high';
	return 'xhigh';
}
