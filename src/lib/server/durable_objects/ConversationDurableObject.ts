import { DurableObject } from 'cloudflare:workers';
import type {
	AddMessageResult,
	Artifact,
	ArtifactType,
	ConversationState,
	JsonValue,
	MessagePart,
	MessageRow,
	MetaSnapshot,
	ToolCallRecord as RecordedToolCall,
} from '$lib/types/conversation';
import { now as nowMs, uuid } from '../clock';
import { listCustomTools } from '../custom_tools';
import { compactHistory } from '../llm/context';
import { formatError } from '../llm/errors';
import type LLM from '../llm/LLM';
import type { ChatRequest, ContentBlock, Message, StreamEvent, ToolDefinition, Usage } from '../llm/LLM';
import { routeLLM } from '../llm/route';
import { sanitizeHistoryForModel } from '../llm/sanitize';
import { listMcpServers } from '../mcp_servers';
import { listMemories } from '../memories';
import { getResolvedModel, listAllModels } from '../providers/models';
import type { ResolvedModel } from '../providers/types';
import { indexMessage as indexSearchMessage } from '../search';
import { getSetting, getSystemPrompt, getUserBio } from '../settings';
import { listStyles } from '../styles';
import { listSubAgents } from '../sub_agents';
import type { ToolCitation } from '../tools/registry';
import { type AddArtifactInput, insertArtifact } from './conversation/artifacts';
import { partsFromJson, partsToJson } from './conversation/blob-store';
import { buildHistory, buildHistoryWithRowIds, hydrateRowParts } from './conversation/history';
import { runMigrations } from './conversation/migrations';
import { dedupeCitationsByUrl, normalizeParts, parseJson, partsToMessages, trimTrailingPartialOutput } from './conversation/parts';
import { resolveReasoningConfig } from './conversation/reasoning';
import { destroySandbox, getSandboxPreviewPorts } from './conversation/sandbox';
import { execRows } from './conversation/sql';
import { readMessages } from './conversation/state-readers';
import { SubscriberSet } from './conversation/subscribers';
import { composeSystemPrompt } from './conversation/system-prompt';
import { TITLE_GEN_SYSTEM_PROMPT, TITLE_REGEN_SYSTEM_PROMPT, writeTitle } from './conversation/title-generator';
import { buildToolRegistry, type ConversationContext, type McpCache } from './conversation/tool-registry-builder';

export type { AddMessageResult, Artifact, ArtifactType, ConversationState, MessageRow, MetaSnapshot };

const MAX_TOOL_ITERATIONS = 10;
const CONTEXT_CACHE_TTL_MS = 30_000;
// SQL fragment used by every history / state fetch on the messages table.
const COMPLETE_PREDICATE = "status = 'complete' AND deleted_at IS NULL";

export default class ConversationDurableObject extends DurableObject<Env> {
	#sql: SqlStorage;
	#subscribers = new SubscriberSet();
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
	// Per-DO cache of MCP tool descriptors keyed by server id. The clients
	// themselves are reused inside the closure so we keep one instance per
	// server. Refreshed on TTL expiry or when the cached entry is cleared.
	#mcpCache: McpCache = new Map();
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
	// Hashes of large image blobs already pushed to R2 during this DO
	// activation. Lets the debounced flush skip redundant `head`/`put` calls
	// for images that haven't changed since the last persist.
	#uploadedBlobHashes: Set<string> = new Set();
	// Single-flight gate for the debounced flush. Concurrent flushes can race
	// because `partsToJson` is async (R2 upload) but the surrounding writes
	// (per-tool persist, abort, end-of-turn) issue synchronous `sql.exec`
	// calls; without this, a late flush could clobber the canonical final
	// row with a stale snapshot.
	#flushPromise: Promise<void> | null = null;
	// Number of long-running operations currently in flight on this DO.
	// While > 0, the alarm() handler refreshes the heartbeat alarm so
	// Cloudflare can't evict the DO before work finishes; on transition
	// to 0 we delete the alarm so the DO hibernates. A counter (rather
	// than a bool) tolerates concurrent callers — e.g. a regenerateTitle
	// racing with a compactContext.
	#activeWorkCount = 0;
	// In-memory flag distinguishing a heartbeat-driven alarm from the
	// constructor's eviction-recovery alarm. On a fresh activation
	// (eviction during work) this resets to false, so alarm() falls
	// through to #detectAndResume() — exactly the legacy behaviour.
	#heartbeatActive = false;
	// Heartbeat interval. 30s comfortably covers a typical streaming
	// chunk gap; tool calls that exceed it get an in-loop refresh in
	// #generate.
	static readonly #HEARTBEAT_MS = 30_000;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			runMigrations(this.#sql);
			// If the DO was evicted mid-generation, leave the row as `streaming`
			// and schedule a near-future alarm. The alarm handler picks up
			// where the dead generation left off so the user doesn't have to
			// retry. Resume also runs lazily on `subscribe` / `addUserMessage`;
			// the alarm is a backstop for the no-traffic case.
			const interrupted = execRows<{ id: string }>(this.#sql, "SELECT id FROM messages WHERE status = 'streaming' LIMIT 1");
			if (interrupted.length > 0) {
				await ctx.storage.setAlarm(Date.now() + 200);
			}
		});
	}

	// Cloudflare invokes this when a previously-set alarm fires. Two roles:
	// (a) heartbeat — while work is in flight on this activation, refresh
	//     the alarm so the runtime can't evict the DO before the next tick.
	// (b) eviction-recovery backstop — if the DO died with a streaming row
	//     (constructor schedules a +200ms alarm) or simply has nothing to
	//     do, fall through to the existing resume path.
	async alarm(): Promise<void> {
		if (this.#heartbeatActive && this.#activeWorkCount > 0) {
			await this.#scheduleHeartbeat();
			return;
		}
		await this.#detectAndResume();
	}

	// A scheduled alarm prevents Cloudflare from evicting the DO until it
	// fires, so we use one as a heartbeat: re-arm it every 30s while work
	// is running, delete it when work ends. Callers of long-running ops
	// own the begin/end pairs; #generate refreshes mid-loop because
	// individual tool calls can exceed the heartbeat interval.
	async #scheduleHeartbeat(): Promise<void> {
		this.#heartbeatActive = true;
		await this.ctx.storage.setAlarm(Date.now() + ConversationDurableObject.#HEARTBEAT_MS);
	}

	async #beginWork(): Promise<void> {
		this.#activeWorkCount++;
		await this.#scheduleHeartbeat();
	}

	async #endWork(): Promise<void> {
		if (this.#activeWorkCount > 0) this.#activeWorkCount--;
		if (this.#activeWorkCount === 0) {
			this.#heartbeatActive = false;
			// Don't clobber a constructor-scheduled eviction-recovery alarm:
			// if a streaming row still exists, leave the alarm in place so
			// the no-traffic resume path can fire.
			const interrupted = execRows<{ id: string }>(this.#sql, "SELECT id FROM messages WHERE status = 'streaming' LIMIT 1");
			if (interrupted.length === 0) {
				await this.ctx.storage.deleteAlarm();
			}
		}
	}

	// `_meta` is a key/value table populated by migration 1. We piggy-back
	// `'conversation_id'` onto it so resume flows that aren't initiated by an
	// HTTP request (constructor / alarm) can find the conversation id without
	// reverse-decoding `ctx.id` (which isn't possible — `idFromName` is
	// one-way).
	#getConversationId(): string | null {
		if (this.#conversationId) return this.#conversationId;
		const row = execRows<{ value: string }>(this.#sql, "SELECT value FROM _meta WHERE key = 'conversation_id'");
		this.#conversationId = row[0]?.value ?? null;
		return this.#conversationId;
	}

	#setConversationId(id: string): void {
		if (this.#conversationId === id) return;
		this.#sql.exec("INSERT INTO _meta (key, value) VALUES ('conversation_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", id);
		this.#conversationId = id;
	}

	// Schedule a debounced write of the in-flight assistant row's
	// content/thinking/parts. Reduces the volume of state lost to a DO
	// eviction from "everything since end-of-tool" to "at most 500ms".
	#scheduleFlush(): void {
		if (this.#flushTimer || !this.#inProgress) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = null;
			void this.#flushNow();
		}, 500);
	}

	async #flushNow(): Promise<void> {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		// Chain after any in-flight flush so two flushes can't write the row
		// with an inverted ordering. The previous one's await-on-R2 might
		// finish second otherwise.
		const previous = this.#flushPromise ?? Promise.resolve();
		const mine = previous.then(async () => {
			const ip = this.#inProgress;
			if (!ip) return;
			// Snapshot the live parts before the await so a mutation during
			// R2 upload (text_delta firing while we're persisting) doesn't
			// land mid-iteration.
			const snapshot = ip.parts.slice();
			const partsJson = await partsToJson(snapshot, this.env, this.#uploadedBlobHashes);
			if (!this.#inProgress || this.#inProgress.messageId !== ip.messageId) return;
			this.#sql.exec(
				'UPDATE messages SET content = ?, thinking = ?, parts = ? WHERE id = ?',
				ip.content,
				ip.thinking || null,
				partsJson,
				ip.messageId,
			);
		});
		this.#flushPromise = mine;
		try {
			await mine;
		} catch {
			// Swallow — caller (the timer) has no recourse and a failed
			// debounced write isn't fatal: the next per-tool persist or the
			// end-of-turn write will overwrite the row.
		} finally {
			// Compare-and-swap: only clear if no later flush has chained on
			// top of this one. Without this guard, a three-deep overlap would
			// reset the chain head while p2 was still pending, letting p3
			// race p2 to write the row.
			if (this.#flushPromise === mine) this.#flushPromise = null;
		}
	}

	async #cancelFlush(): Promise<void> {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		// A flush that already started before the cancel still has its
		// async work (R2 upload + SQL exec) pending. Wait for it so the
		// caller's subsequent canonical write isn't clobbered.
		if (this.#flushPromise) {
			try {
				await this.#flushPromise;
			} catch {
				/* see #flushNow */
			}
		}
	}

	// Detect a streaming row left behind by a previous activation and resume
	// its generation. Idempotent: if a resume is already in flight, or the DO
	// is already mid-generation (live `#inProgress`), this is a no-op. Safe
	// to call from constructor (via alarm), `subscribe`, and
	// `addUserMessage`.
	async #detectAndResume(): Promise<void> {
		if (this.#resumePromise || this.#inProgress) return;
		const rows = execRows<{ id: string; model: string | null }>(
			this.#sql,
			"SELECT id, model FROM messages WHERE status = 'streaming' ORDER BY created_at ASC",
		);
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

		const conversationId = this.#getConversationId();
		if (!conversationId) {
			this.#sql.exec(
				"UPDATE messages SET status = 'error', error = ? WHERE id = ?",
				'Cannot resume generation: conversation id unknown.',
				messageId,
			);
			this.#subscribers.broadcast('refresh', {});
			return;
		}

		// Resolve the model to use for resumption. The row's stored model is
		// the first choice, but operators sometimes delete or rename models in
		// `/settings` while a streaming row is alive. Fall back to the user's
		// global `default_model` setting, then to any configured model, before
		// giving up — anything's better than bricking the conversation with a
		// permanent error row.
		const resolvedResume = await this.#resolveResumeModel(target.model);
		if (!resolvedResume) {
			this.#sql.exec(
				"UPDATE messages SET status = 'error', error = ? WHERE id = ?",
				'Cannot resume generation: no usable model is configured. Add a model in /settings and retry.',
				messageId,
			);
			this.#subscribers.broadcast('refresh', {});
			return;
		}
		const model = resolvedResume.model;
		const fellBackFrom = resolvedResume.fellBackFrom;

		// Hydrate `#inProgress` from the persisted row. Trim any trailing
		// partial text/thinking (those followed the last completed tool round
		// and were unflushed when the DO died) and normalize any orphan
		// tool_use blocks so the LLM history is valid.
		const row = execRows<{ parts: string | null }>(this.#sql, 'SELECT parts FROM messages WHERE id = ?', messageId);
		const persistedParts = (await partsFromJson(row[0]?.parts ?? null, this.env)) ?? [];
		const trimmed = trimTrailingPartialOutput(persistedParts);
		normalizeParts(trimmed, 'Generation interrupted by Durable Object restart; retrying.');

		// If we fell back to a different model, surface that in the timeline
		// so the user can see why the response is now coming from a different
		// model than they originally picked. Update the row's `model` column
		// before resuming so all downstream code sees the new model.
		if (fellBackFrom != null) {
			const infoText =
				fellBackFrom === ''
					? `Resumed with model: ${model} (no model was recorded for this turn)`
					: `Original model "${fellBackFrom}" is no longer configured; resumed with ${model}.`;
			trimmed.push({ text: infoText, type: 'info' });
		}

		this.#sql.exec(
			"UPDATE messages SET content = '', thinking = NULL, model = ?, parts = ?, started_at = ? WHERE id = ?",
			model,
			await partsToJson(trimmed, this.env, this.#uploadedBlobHashes),
			nowMs(),
			messageId,
		);
		if (fellBackFrom != null) {
			this.#subscribers.broadcast('model_switch', { messageId, model });
		}

		this.#inProgress = {
			abortController: new AbortController(),
			content: '',
			firstTokenAt: 0,
			lastChunk: null,
			messageId,
			parts: trimmed,
			providerID: null,
			startedAt: 0,
			thinking: '',
			usage: null,
		};
		this.#subscribers.broadcast('refresh', {});

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

	async getState(): Promise<ConversationState> {
		const messages = await readMessages(this.#sql, this.env);
		if (this.#inProgress) {
			const ip = this.#inProgress;
			const merged = messages.map((m) =>
				m.id === ip.messageId
					? {
							...m,
							content: ip.content,
							parts: ip.parts.length > 0 ? ip.parts.slice() : m.parts,
							thinking: ip.thinking || m.thinking,
						}
					: m,
			);
			return { inProgress: { content: ip.content, messageId: ip.messageId }, messages: merged };
		}
		return { inProgress: null, messages };
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
		if (!trimmed) return { reason: 'empty', status: 'invalid' };
		if (!model) return { reason: 'missing model', status: 'invalid' };

		const now = nowMs();
		const systemId = uuid();
		const userId = uuid();
		const assistantId = uuid();

		const systemContent = `The current date and time is: ${new Date(now).toUTCString()}`;
		this.#sql.exec(
			"INSERT INTO messages (id, role, content, model, status, created_at) VALUES (?, 'system', ?, NULL, 'complete', ?)",
			systemId,
			systemContent,
			now,
		);

		this.#sql.exec(
			"INSERT INTO messages (id, role, content, model, status, created_at) VALUES (?, 'user', ?, NULL, 'complete', ?)",
			userId,
			trimmed,
			now + 1,
		);
		this.#sql.exec(
			"INSERT INTO messages (id, role, content, model, status, created_at) VALUES (?, 'assistant', '', ?, 'streaming', ?)",
			assistantId,
			model,
			now + 2,
		);

		this.#inProgress = {
			abortController: new AbortController(),
			content: '',
			firstTokenAt: 0,
			lastChunk: null,
			messageId: assistantId,
			parts: [],
			providerID: null,
			startedAt: 0,
			thinking: '',
			usage: null,
		};

		await this.#touchConversation(conversationId, trimmed);
		// Index the user message for full-text search. waitUntil so D1 latency
		// doesn't gate the SSE refresh.
		this.ctx.waitUntil(
			indexSearchMessage(this.env, {
				conversationId,
				createdAt: now + 1,
				messageId: userId,
				role: 'user',
				text: trimmed,
			}).catch(() => {}),
		);
		this.#subscribers.broadcast('refresh', {});

		this.ctx.waitUntil(this.#generate(conversationId, assistantId, model));
		return { status: 'started' };
	}

	async regenerateTitle(conversationId: string): Promise<void> {
		this.#setConversationId(conversationId);
		await this.#beginWork();
		try {
			const history = execRows<{ role: string; content: string }>(
				this.#sql,
				`SELECT role, content FROM messages WHERE ${COMPLETE_PREDICATE} ORDER BY created_at ASC`,
			);
			const transcript = history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
			await writeTitle(
				this.env,
				conversationId,
				transcript.slice(0, 4000),
				{ onlyIfDefault: false, systemPrompt: TITLE_REGEN_SYSTEM_PROMPT },
				{ getContext: () => this.#getContext(), routeLLM: (id, opts) => this.#routeLLM(id, opts) },
			);
			this.#subscribers.broadcast('refresh', {});
		} finally {
			await this.#endWork();
		}
	}

	async setThinkingBudget(conversationId: string, budget: number | null): Promise<void> {
		this.#setConversationId(conversationId);
		// Per-conversation thinking token budget. AnthropicLLM honors this when
		// the model supports extended thinking; OpenRouterLLM ignores it.
		const value = budget != null && budget > 0 ? Math.floor(budget) : null;
		await this.env.DB.prepare('UPDATE conversations SET thinking_budget = ? WHERE id = ?').bind(value, conversationId).run();
	}

	async setSystemPrompt(conversationId: string, prompt: string | null): Promise<void> {
		this.#setConversationId(conversationId);
		if (prompt != null && prompt.length > 16_384) {
			throw new Error('system_prompt exceeds 16384 characters');
		}
		const trimmed = prompt?.trim() || null;
		await this.env.DB.prepare('UPDATE conversations SET system_prompt = ? WHERE id = ?').bind(trimmed, conversationId).run();
		this.#subscribers.broadcast('refresh', {});
	}

	async setStyle(conversationId: string, styleId: number | null): Promise<void> {
		this.#setConversationId(conversationId);
		const value = styleId != null && styleId > 0 ? Math.floor(styleId) : null;
		await this.env.DB.prepare('UPDATE conversations SET style_id = ? WHERE id = ?').bind(value, conversationId).run();
		this.#subscribers.broadcast('refresh', {});
	}

	async abortGeneration(conversationId: string): Promise<void> {
		this.#setConversationId(conversationId);
		if (!this.#inProgress) return;
		const ip = this.#inProgress;
		// Cancel any pending debounced flush — we're about to write the
		// canonical final state for this row, and a stale flush landing
		// after it would resurrect status='streaming'.
		await this.#cancelFlush();
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
		const partsJson = await partsToJson(ip.parts, this.env, this.#uploadedBlobHashes);
		this.#sql.exec(
			`UPDATE messages SET content = ?, status = 'complete', thinking = ?, parts = ?, started_at = ?, first_token_at = ?, last_chunk_json = ?, usage_json = ?, provider = ? WHERE id = ?`,
			ip.content,
			ip.thinking || null,
			partsJson,
			ip.startedAt || null,
			ip.firstTokenAt || null,
			ip.lastChunk ? JSON.stringify(ip.lastChunk) : null,
			ip.usage ? JSON.stringify(ip.usage) : null,
			ip.providerID,
			ip.messageId,
		);
		this.#inProgress = null;
		this.#subscribers.broadcast('refresh', {});
	}

	async compactContext(conversationId: string): Promise<{ compacted: boolean; droppedCount: number }> {
		this.#setConversationId(conversationId);
		if (this.#inProgress || this.#resumePromise) return { compacted: false, droppedCount: 0 };

		await this.#beginWork();
		try {
			const lastModelRow = execRows<{ model: string | null }>(
				this.#sql,
				`SELECT model FROM messages WHERE role = 'assistant' AND ${COMPLETE_PREDICATE} ORDER BY created_at DESC LIMIT 1`,
			);
			const model = lastModelRow[0]?.model;
			if (!model) return { compacted: false, droppedCount: 0 };

			const historyRaw = execRows<{ id: string; role: string; content: string; parts: string | null }>(
				this.#sql,
				`SELECT id, role, content, parts FROM messages WHERE ${COMPLETE_PREDICATE} ORDER BY created_at ASC`,
			);
			const history = await hydrateRowParts(historyRaw, this.env);

			const { messages, rowIdAtIndex: rowIdAtLLMIndex } = buildHistoryWithRowIds(history);

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
				text: `Context compacted: summarized ${rowsToDelete.size} earlier messages. Summary: ${compaction.summary}`,
				type: 'info',
			};
			this.#sql.exec(
				"INSERT INTO messages (id, role, content, model, status, parts, created_at) VALUES (?, 'assistant', ?, ?, 'complete', ?, ?)",
				summaryId,
				compaction.summary,
				model,
				await partsToJson([infoPart], this.env, this.#uploadedBlobHashes),
				now + 1,
			);

			this.#subscribers.broadcast('refresh', {});
			return { compacted: true, droppedCount: rowsToDelete.size };
		} finally {
			await this.#endWork();
		}
	}

	// Wipe all DO storage. Cloudflare doesn't expose a "delete this DO from
	// the namespace" API, but `ctx.storage.deleteAll()` drops every row in
	// the SQLite store, so the next time something resolves this DO id it'll
	// be a fresh, empty instance. Pair with `deleteConversation()` in D1 to
	// fully evict a conversation. Closes any live SSE subscribers first so
	// they don't keep streaming on an already-vanished conversation.
	async destroy(): Promise<void> {
		const conversationId = this.#conversationId;
		// Abort the in-flight generation BEFORE nulling the reference so the
		// running llm.chat({signal}) and registry.execute({signal}) actually
		// stop. Without this the current iteration finishes, fires R2 puts /
		// tool HTTP calls, and tries to UPDATE the now-deleteAll()'d table.
		const inProgress = this.#inProgress;
		if (inProgress) {
			try {
				inProgress.abortController.abort('destroyed');
			} catch {
				/* ignore */
			}
		}
		this.#inProgress = null;
		await this.#cancelFlush();
		// Clear per-activation caches so a re-resolved DO with the same id
		// doesn't inherit stale state.
		this.#mcpCache = new Map();
		this.#contextCache = null;
		this.#uploadedBlobHashes = new Set();
		this.#resumePromise = null;
		this.#activeWorkCount = 0;
		this.#heartbeatActive = false;
		this.#conversationId = null;
		this.#subscribers.closeAll();
		await this.ctx.storage.deleteAll();
		// Tear down the conversation's sandbox container (best-effort).
		await destroySandbox(this.env, conversationId);
	}

	// -------------------------------------------------------------------------
	// Sandbox helpers
	// -------------------------------------------------------------------------

	async getSandboxPreviewPorts(hostname: string): Promise<{ port: number; url: string; name?: string }[]> {
		return getSandboxPreviewPorts(this.env, this.#getConversationId(), hostname);
	}

	async subscribe(): Promise<ReadableStream<Uint8Array>> {
		let storedSub: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number } | null = null;
		const self = this;

		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				if (storedSub) self.#subscribers.delete(storedSub);
			},
			start(controller) {
				storedSub = { controller, nextId: 1 };
				self.#subscribers.add(storedSub);
				// Tell the browser to wait 3s before reconnecting on a dropped
				// connection, and send the current snapshot so the client can
				// resume without a full page reload.
				controller.enqueue(self.#subscribers.encode('retry: 3000\n\n'));
				void self.#sendSync(storedSub);
			},
		});

		// If a previous activation died mid-generation, resume now that a
		// client is here to watch. The resume's broadcast events will reach
		// the new subscriber via the normal `#broadcast` path.
		void this.#detectAndResume();

		return stream;
	}

	async #sendSync(sub: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number }): Promise<void> {
		const messages = await readMessages(this.#sql, this.env);
		const last = messages[messages.length - 1];
		if (!last) return;
		const inProgress = this.#inProgress;
		const isInProgress = inProgress?.messageId === last.id;
		const content = isInProgress && inProgress ? inProgress.content : last.content;
		// Send the live timeline along with content so a subscriber that
		// reconnects mid-stream can replace its (possibly empty) parts list
		// with the server-side truth before any subsequent deltas arrive.
		// Without this, the first delta after reconnect would seed `parts`
		// from scratch and the renderer would drop the SSR'd content.
		const parts = isInProgress && inProgress ? inProgress.parts.slice() : (last.parts ?? null);
		const thinking = isInProgress && inProgress ? inProgress.thinking : (last.thinking ?? null);
		this.#subscribers.enqueueTo(sub, 'sync', {
			lastMessageContent: content,
			lastMessageId: last.id,
			lastMessageParts: parts,
			lastMessageStatus: last.status,
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

	// Test-only synchronization barriers. Each entry is awaited inside the
	// tool-execution loop just before the corresponding `registry.execute()`
	// call. Lets a test hold the loop while one or more tools are "in
	// flight" so it can call `abortGeneration` (and queue a follow-up turn)
	// at a deterministic point in time. Each `__armToolExecBarrier` enqueues
	// one hold; the next tool exec to run pops the front of the queue and
	// awaits it. `__releaseToolExecBarrier(slot)` resolves the hold at
	// `slot` (FIFO insertion order, 0-based).
	__toolExecHolds: Array<Promise<void>> = [];
	#toolExecReleases: Array<() => void> = [];

	async __armToolExecBarrier(): Promise<number> {
		let release!: () => void;
		const promise = new Promise<void>((r) => {
			release = r;
		});
		this.__toolExecHolds.push(promise);
		this.#toolExecReleases.push(release);
		return this.#toolExecReleases.length - 1;
	}

	async __releaseToolExecBarrier(slot: number): Promise<void> {
		const release = this.#toolExecReleases[slot];
		if (release) {
			this.#toolExecReleases[slot] = () => {};
			release();
		}
	}

	// Resolve the model to use for resumption when the streaming row's stored
	// `model` may be stale (deleted from `/settings`) or null (legacy row).
	// Returns the resolved global id and, when a fallback was applied, the
	// original value so the caller can surface it in the timeline. Returns
	// null only when no model resolves at all.
	async #resolveResumeModel(stored: string | null): Promise<{ model: string; fellBackFrom: string | null } | null> {
		// When tests inject a scripted LLM via __setLLMOverride, `#routeLLM`
		// short-circuits without consulting D1, so a stored sentinel like
		// "fake/model" looks unresolvable here. Trust the stored value when
		// it's non-empty — the override decides what actually runs. Null
		// `stored` still falls through to the resolve-or-fallback path so
		// the bug "model column was never set" stays covered.
		if (this.__llmOverrideScript && stored) {
			return { fellBackFrom: null, model: stored };
		}
		if (stored) {
			const direct = await getResolvedModel(this.env, stored).catch(() => null);
			if (direct) return { fellBackFrom: null, model: stored };
		}
		const fallbackOriginal = stored ?? '';
		const defaultModel = await getSetting(this.env, 'default_model').catch(() => null);
		if (defaultModel) {
			const resolvedDefault = await getResolvedModel(this.env, defaultModel).catch(() => null);
			if (resolvedDefault) return { fellBackFrom: fallbackOriginal, model: defaultModel };
		}
		const all = await listAllModels(this.env).catch(() => []);
		if (all.length > 0) {
			const first = `${all[0].providerId}/${all[0].id}`;
			return { fellBackFrom: fallbackOriginal, model: first };
		}
		return null;
	}

	async #routeLLM(globalId: string, opts: { purpose?: 'main' | 'title' } = {}): Promise<LLM> {
		const isTitle = opts.purpose === 'title';
		const script = isTitle ? this.__titleLLMOverrideScript : this.__llmOverrideScript;
		if (script) {
			const calls = isTitle ? this.__titleLLMOverrideCalls : this.__llmOverrideCalls;
			return {
				async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
					calls.push(req);
					const turn = script.shift();
					if (!turn) {
						yield { message: 'FakeLLM: ran out of scripted turns', type: 'error' };
						return;
					}
					for (const ev of turn) yield ev;
				},
				model: globalId,
				providerID: 'fake',
			};
		}
		const resolved = await getResolvedModel(this.env, globalId);
		if (!resolved) throw new Error(`Unknown model: ${globalId}`);
		const llm = routeLLM(resolved.provider, resolved.model);
		return {
			chat: (req) => llm.chat(req),
			model: globalId,
			providerID: resolved.provider.id,
		};
	}

	async #generate(conversationId: string, assistantId: string, model: string): Promise<void> {
		const ip = this.#inProgress;
		if (!ip) throw new Error('#generate called without an in-progress message');
		ip.startedAt = nowMs();
		// Heartbeat: while #generate is running, keep an alarm scheduled so
		// Cloudflare can't evict the DO mid-stream. All exit paths below
		// (success / error / abort early-returns) call #endWork() to clear
		// the alarm and let the DO hibernate.
		await this.#beginWork();

		// Live mirror of the turn lives on `this.#inProgress.parts` so a
		// resubscribing client can pick up the timeline as it stands. We
		// alias it locally for readability.
		const parts = ip.parts;
		const signal = ip.abortController.signal;
		// `parts` is the canonical timeline. Citations don't have a place in
		// the parts shape (they're surfaced separately to the UI), so we
		// accumulate them as the loop runs.
		const accumulatedCitations: ToolCitation[] = [];
		// Stable, 1-based global citation index by URL for this turn. Tools
		// that emit citations call `ctx.registerCitation(c)` to get an index,
		// then embed it as `[N]` in their result text. The agent learns to
		// reference those same numbers inline ("Paris is the capital [1]."),
		// and the markdown renderer turns each `[N]` into a link to the
		// matching entry in the Sources block. Tools that return citations
		// the legacy way (via `result.citations`) still get their entries
		// merged into the same map below — those entries just won't have
		// inline markers since the tool didn't know its index.
		const citationIndexByUrl = new Map<string, number>();
		const registerCitation = (c: ToolCitation): number => {
			const existing = citationIndexByUrl.get(c.url);
			if (existing !== undefined) return existing;
			const idx = accumulatedCitations.length + 1;
			accumulatedCitations.push(c);
			citationIndexByUrl.set(c.url, idx);
			return idx;
		};
		const appendText = (delta: string) => {
			const last = parts[parts.length - 1];
			if (last && last.type === 'text') {
				last.text += delta;
			} else {
				parts.push({ text: delta, type: 'text' });
			}
		};
		const appendThinking = (delta: string) => {
			const last = parts[parts.length - 1];
			if (last && last.type === 'thinking') {
				last.text += delta;
			} else {
				parts.push({ text: delta, type: 'thinking' });
			}
		};
		const attachThinkingSignature = (signature: string) => {
			// Anthropic emits the signature once per thinking block at
			// content_block_stop. Walk back to the most recent thinking part
			// in this turn and stamp the signature so subsequent turns can
			// round-trip it. If text was already streamed after the thinking
			// block, the most recent thinking is still the right target — text
			// blocks don't carry signatures.
			for (let i = parts.length - 1; i >= 0; i--) {
				const p = parts[i];
				if (p.type === 'thinking' && !p.signature) {
					p.signature = signature;
					return;
				}
			}
		};

		this.#sql.exec('UPDATE messages SET started_at = ? WHERE id = ?', ip.startedAt, assistantId);

		try {
			let currentModel = model;
			let llm = await this.#routeLLM(model);
			const historyRaw = execRows<{ role: string; content: string; parts: string | null }>(
				this.#sql,
				`SELECT role, content, parts FROM messages WHERE id != ? AND ${COMPLETE_PREDICATE} ORDER BY created_at ASC`,
				assistantId,
			);
			const history = await hydrateRowParts(historyRaw, this.env);
			let messages: Message[] = buildHistory(history);

			// Resume case: if `parts` was hydrated from a persisted row that
			// contains completed tool rounds, the LLM needs to see those
			// tool_use/tool_result pairs so it continues from after them
			// instead of redoing the work. Splice them in as synthetic prior
			// assistant + tool messages.
			const recoveredHasTools = parts.some((p) => p.type === 'tool_use' || p.type === 'tool_result');
			if (recoveredHasTools) {
				messages.push(...partsToMessages(parts));
			}

			// Check whether we need to compact context before sending. The
			// `usage_json` column has held the canonical `Usage` shape
			// (`inputTokens`/`cacheReadInputTokens`) since round 1; the older
			// OpenRouter-style `{promptTokens, promptTokensDetails}` shape is
			// kept as a fallback for legacy rows.
			const lastUsageRow = execRows<{ usage_json: string | null }>(
				this.#sql,
				`SELECT usage_json FROM messages WHERE role = 'assistant' AND ${COMPLETE_PREDICATE} ORDER BY created_at DESC LIMIT 1`,
			);
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
						cacheReadInputTokens: lastUsage.cacheReadInputTokens ?? lastUsage.promptTokensDetails?.cachedTokens,
						inputTokens: lastUsage.inputTokens ?? lastUsage.promptTokens ?? 0,
					}
				: null;
			const compaction = await compactHistory(messages, model, this.env, usageForCompaction, {
				llm: (_env, id) => this.#routeLLM(id),
			});
			if (compaction.wasCompacted) {
				const infoPart: MessagePart = {
					text: `Context compacted: summarized ${compaction.droppedCount} earlier messages to stay within the model's limit.`,
					type: 'info',
				};
				parts.push(infoPart);
				this.#sql.exec('UPDATE messages SET parts = ? WHERE id = ?', await partsToJson(parts, this.env, this.#uploadedBlobHashes), assistantId);
				this.#subscribers.broadcast('part', { messageId: assistantId, part: infoPart });
				messages = compaction.messages;
			}

			const [context, convoRow] = await Promise.all([
				this.#getContext(),
				this.env.DB.prepare('SELECT thinking_budget, style_id, system_prompt FROM conversations WHERE id = ?')
					.bind(conversationId)
					.first<{ thinking_budget: number | null; style_id: number | null; system_prompt: string | null }>(),
			]);
			const thinkingBudget = convoRow?.thinking_budget ?? null;
			const conversationStyleId = convoRow?.style_id ?? null;
			const conversationSystemPromptOverride = convoRow?.system_prompt ?? null;

			// Resolve the routed model from the cached models list rather than
			// hitting D1 again. `getResolvedModel`'s D1 reads happen inside
			// `#routeLLM`, so the route already has the provider+model bytes
			// in flight.
			const resolved: ResolvedModel | null = await getResolvedModel(this.env, model);
			const { reasoning, thinking } = resolveReasoningConfig({
				providerType: resolved?.provider.type ?? null,
				reasoningType: resolved?.model.reasoningType ?? null,
				thinkingBudget,
			});

			const systemPrompt = composeSystemPrompt({
				conversationOverride: conversationSystemPromptOverride,
				conversationStyleId,
				globalSystemPrompt: context.systemPrompt,
				memories: context.memories,
				styles: context.styles,
				userBio: context.userBio,
			});

			const registry = await buildToolRegistry(this.env, this.#mcpCache, model, context);
			const tools: ToolDefinition[] | undefined = registry.definitions().length > 0 ? registry.definitions() : undefined;

			ip.providerID = llm.providerID;
			// `resolved` tracks the ResolvedModel for the current iteration so
			// `sanitizeHistoryForModel` can filter incompatible content (images,
			// thinking) before each chat call. Reset whenever `currentModel`
			// changes via `switch_model`.
			let resolvedForRoute: ResolvedModel | null = resolved;
			let hitIterationCap = false;
			for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
				// Slide the heartbeat alarm forward each iteration; a single
				// LLM streaming round + tool call can exceed 30s.
				await this.#scheduleHeartbeat();
				const turnToolCalls: RecordedToolCall[] = [];
				let turnText = '';
				let providerError: string | null = null;
				const isLastIteration = iteration === MAX_TOOL_ITERATIONS - 1;

				for await (const ev of llm.chat({
					messages: sanitizeHistoryForModel(messages, resolvedForRoute),
					signal,
					systemPrompt,
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
						this.#subscribers.broadcast('delta', { content: ev.delta, messageId: assistantId });
						this.#scheduleFlush();
					} else if (ev.type === 'thinking_delta') {
						ip.thinking += ev.delta;
						appendThinking(ev.delta);
						this.#subscribers.broadcast('thinking_delta', { content: ev.delta, messageId: assistantId });
						this.#scheduleFlush();
					} else if (ev.type === 'thinking_signature') {
						attachThinkingSignature(ev.signature);
						this.#scheduleFlush();
					} else if (ev.type === 'tool_call') {
						turnToolCalls.push({ id: ev.id, input: ev.input as JsonValue, name: ev.name, thoughtSignature: ev.thoughtSignature });
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
				if (turnText) assistantBlocks.push({ text: turnText, type: 'text' });
				for (const tc of turnToolCalls) {
					assistantBlocks.push({ id: tc.id, input: tc.input, name: tc.name, thoughtSignature: tc.thoughtSignature, type: 'tool_use' });
				}
				messages.push({ content: assistantBlocks, role: 'assistant' });

				// Execute each tool, broadcast call+result events, append result to history.
				// We push the `tool_use` and a preliminary streaming `tool_result`
				// to the parts mirror BEFORE execute so an abort mid-execution
				// always sees a paired pair. The preliminary part is swapped for
				// the final result on completion, and a streaming
				// `emitToolOutput` callback streams output chunks to the UI.
				let pendingModelSwitch: string | null = null;
				for (const call of turnToolCalls) {
					if (!this.#inProgress || this.#inProgress.messageId !== assistantId) break;
					const callStartedAt = nowMs();
					parts.push({
						id: call.id,
						input: call.input,
						name: call.name,
						startedAt: callStartedAt,
						thoughtSignature: call.thoughtSignature,
						type: 'tool_use',
					});
					this.#subscribers.broadcast('tool_call', {
						id: call.id,
						input: call.input,
						messageId: assistantId,
						name: call.name,
						startedAt: callStartedAt,
						thoughtSignature: call.thoughtSignature,
					});
					// Seed a preliminary streaming tool_result so the UI shows the
					// call as active while output arrives. Replaced with the final
					// result once execution completes.
					parts.push({
						content: '',
						isError: false,
						startedAt: callStartedAt,
						streaming: true,
						toolUseId: call.id,
						type: 'tool_result',
					});
					this.#subscribers.broadcast('tool_result', {
						content: '',
						isError: false,
						messageId: assistantId,
						startedAt: callStartedAt,
						streaming: true,
						toolUseId: call.id,
					});
					// Test-only synchronization point: lets tests pause the loop
					// after the preliminary tool_result is published but before the
					// real tool runs, so abortGeneration can fire while the tool is
					// "in flight." A no-op outside of tests.
					const hold = this.__toolExecHolds.shift();
					if (hold) {
						await hold;
					}
					const result = await registry.execute(
						{
							assistantMessageId: assistantId,
							conversationId,
							emitToolOutput: (chunk: string) => {
								this.#subscribers.broadcast('tool_output', {
									chunk,
									messageId: assistantId,
									toolUseId: call.id,
								});
							},
							env: this.env,
							modelId: currentModel,
							registerCitation,
							signal,
							switchModel: (newModelId: string) => {
								pendingModelSwitch = newModelId;
							},
						},
						call.name,
						call.input,
					);
					// Regression: abortGeneration may have fired while the tool was
					// running. If so, #inProgress is null (or for a different
					// message that started in the meantime) and the persisted
					// row already reflects the abort. Bail out before touching
					// the DB so we don't overwrite the abort state with the
					// post-exec result, and don't cancel an unrelated message's
					// flush timer.
					if (!this.#inProgress || this.#inProgress.messageId !== assistantId) break;
					// Long-running tool just returned — refresh the heartbeat
					// alarm so the next iteration's setup work has a full
					// 30s window before the runtime can evict.
					await this.#scheduleHeartbeat();
					const callEndedAt = nowMs();
					// Swap the preliminary streaming part for the final result.
					const partsIdx = parts.findIndex((p) => p.type === 'tool_result' && p.toolUseId === call.id);
					if (partsIdx >= 0) {
						parts[partsIdx] = {
							content: result.content,
							endedAt: callEndedAt,
							isError: result.isError ?? false,
							startedAt: callStartedAt,
							toolUseId: call.id,
							type: 'tool_result',
						};
					} else {
						parts.push({
							content: result.content,
							endedAt: callEndedAt,
							isError: result.isError ?? false,
							startedAt: callStartedAt,
							toolUseId: call.id,
							type: 'tool_result',
						});
					}
					// Persist the running parts column each step so stream death
					// or DO eviction leaves a row that's still consistent. We
					// also need content/thinking flushed here so any debounced
					// delta flush isn't beaten to the row.
					await this.#cancelFlush();
					this.#sql.exec(
						'UPDATE messages SET content = ?, thinking = ?, parts = ? WHERE id = ?',
						ip.content,
						ip.thinking || null,
						await partsToJson(parts, this.env, this.#uploadedBlobHashes),
						assistantId,
					);
					if (result.citations) {
						// Legacy path: tools that didn't use registerCitation still
						// surface citations via result.citations. Merge through the
						// same dedup map so the Sources block is consistent.
						for (const c of result.citations) registerCitation(c);
					}
					if (result.artifacts) {
						for (const a of result.artifacts) {
							this.addArtifact({
								content: a.content,
								language: a.language ?? null,
								messageId: assistantId,
								name: a.name ?? null,
								type: a.type,
							});
						}
					}
					this.#subscribers.broadcast('tool_result', {
						content: result.content,
						endedAt: callEndedAt,
						isError: result.isError ?? false,
						messageId: assistantId,
						startedAt: callStartedAt,
						toolUseId: call.id,
					});

					messages.push({
						content: [
							{
								content: result.content,
								toolUseId: call.id,
								type: 'tool_result',
								...(result.isError ? { isError: true } : {}),
							},
						],
						role: 'tool',
					});
				}

				if (pendingModelSwitch && pendingModelSwitch !== currentModel && this.#inProgress?.messageId === assistantId) {
					currentModel = pendingModelSwitch;
					llm = await this.#routeLLM(currentModel);
					ip.providerID = llm.providerID;
					// Refresh the resolved model so the next iteration's
					// sanitize pass uses the new model's capabilities (e.g. a
					// switch from a vision model to a text-only one strips
					// images from history before the next chat call).
					resolvedForRoute = await getResolvedModel(this.env, currentModel);
					const infoPart: MessagePart = { text: `Switched to model: ${currentModel}`, type: 'info' };
					parts.push(infoPart);
					this.#sql.exec(
						'UPDATE messages SET model = ?, parts = ? WHERE id = ?',
						currentModel,
						await partsToJson(parts, this.env, this.#uploadedBlobHashes),
						assistantId,
					);
					this.#subscribers.broadcast('part', { messageId: assistantId, part: infoPart });
					this.#subscribers.broadcast('model_switch', { messageId: assistantId, model: currentModel });
				}

				if (isLastIteration && this.#inProgress?.messageId === assistantId) {
					// We executed this iteration's tools but the loop is about to
					// exit, so the model never gets to respond to the results.
					// Surface that explicitly so the user knows why the answer
					// stops mid-flow.
					hitIterationCap = true;
					const infoPart: MessagePart = {
						text: `Tool iteration budget exhausted (${MAX_TOOL_ITERATIONS} rounds). The model did not produce a final answer; ask a follow-up to continue.`,
						type: 'info',
					};
					parts.push(infoPart);
					this.#subscribers.broadcast('part', { messageId: assistantId, part: infoPart });
				}
			}
			void hitIterationCap;

			if (!this.#inProgress || this.#inProgress.messageId !== assistantId) {
				// Aborted by user — don't overwrite the row already persisted by abortGeneration.
				await this.#cancelFlush();
				await this.#endWork();
				return;
			}
			// Cancel any pending debounced flush so a stale write doesn't land
			// after the canonical final UPDATE below resets status to complete.
			await this.#cancelFlush();
			// Surface accumulated citations as a dedicated part so the UI gets
			// a "Sources" block. Dedupe by URL — a turn that runs `web_search`
			// twice for the same query shouldn't list each result twice.
			let citationsPart: MessagePart | null = null;
			if (accumulatedCitations.length > 0) {
				const deduped = dedupeCitationsByUrl(accumulatedCitations);
				citationsPart = { citations: deduped, type: 'citations' };
				parts.push(citationsPart);
			}
			const finalText = this.#inProgress.content;
			const finalThinking = this.#inProgress.thinking;
			const finalPartsJson = await partsToJson(parts, this.env, this.#uploadedBlobHashes);
			this.#sql.exec(
				`UPDATE messages SET content = ?, status = 'complete', first_token_at = ?, last_chunk_json = ?, usage_json = ?, provider = ?, thinking = ?, parts = ? WHERE id = ?`,
				finalText,
				ip.firstTokenAt || null,
				ip.lastChunk ? JSON.stringify(ip.lastChunk) : null,
				ip.usage ? JSON.stringify(ip.usage) : null,
				llm.providerID,
				finalThinking || null,
				finalPartsJson,
				assistantId,
			);
			this.#inProgress = null;
			await this.env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(nowMs(), conversationId).run();
			this.ctx.waitUntil(
				indexSearchMessage(this.env, {
					conversationId,
					createdAt: ip.startedAt || nowMs(),
					messageId: assistantId,
					role: 'assistant',
					text: finalText,
				}).catch(() => {}),
			);
			this.#subscribers.broadcast('meta', {
				messageId: assistantId,
				snapshot: { firstTokenAt: ip.firstTokenAt, lastChunk: ip.lastChunk, startedAt: ip.startedAt, usage: ip.usage },
			});
			if (citationsPart) {
				this.#subscribers.broadcast('part', { messageId: assistantId, part: citationsPart });
			}
			this.#subscribers.broadcast('refresh', {});
			await this.#endWork();
		} catch (e) {
			if (!this.#inProgress || this.#inProgress.messageId !== assistantId) {
				// Already aborted and cleaned up by abortGeneration.
				await this.#cancelFlush();
				await this.#endWork();
				return;
			}
			await this.#cancelFlush();
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
			this.#subscribers.broadcast('refresh', {});
			await this.#endWork();
		}
	}

	// Per-turn snapshot of the static-ish D1 config (settings + sub-agents
	// + mcp servers + provider models). Cached per-DO with a 30s TTL so a
	// chat turn issues at most one round of fetches instead of ~10.
	async #getContext(): Promise<ConversationContext> {
		const cached = this.#contextCache;
		if (cached && nowMs() - cached.fetchedAt < CONTEXT_CACHE_TTL_MS) return cached.context;
		const [systemPrompt, userBio, allModels, subAgents, mcpServers, memories, styles, customTools] = await Promise.all([
			getSystemPrompt(this.env),
			getUserBio(this.env),
			listAllModels(this.env),
			listSubAgents(this.env),
			listMcpServers(this.env),
			listMemories(this.env),
			listStyles(this.env),
			listCustomTools(this.env),
		]);
		const context: ConversationContext = {
			allModels,
			customTools,
			mcpServers,
			memories,
			styles,
			subAgents,
			systemPrompt,
			userBio,
		};
		this.#contextCache = { context, fetchedAt: nowMs() };
		return context;
	}

	async addArtifact(input: AddArtifactInput): Promise<Artifact> {
		const artifact = await insertArtifact(this.#sql, input);
		this.#subscribers.broadcast('artifact', { artifact });
		return artifact;
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
		this.ctx.waitUntil(
			writeTitle(
				this.env,
				conversationId,
				firstMessageContent,
				{ onlyIfDefault: true, systemPrompt: TITLE_GEN_SYSTEM_PROMPT },
				{ getContext: () => this.#getContext(), routeLLM: (id, opts) => this.#routeLLM(id, opts) },
			),
		);
	}
}
