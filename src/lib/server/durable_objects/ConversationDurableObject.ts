import { DurableObject } from 'cloudflare:workers';
import { routeLLM } from '../llm/route';
import { compactHistory } from '../llm/context';
import { formatError } from '../llm/errors';
import type LLM from '../llm/LLM';
import type { ChatRequest, ContentBlock, Message, StreamEvent, ToolDefinition, Usage } from '../llm/LLM';
import type { ToolCitation } from '../tools/registry';
import { listMcpServers } from '../mcp_servers';
import { listSubAgents } from '../sub_agents';
import { listMemories } from '../memories';
import { listStyles } from '../styles';
import { getSystemPrompt, getUserBio } from '../settings';
import { indexMessage as indexSearchMessage } from '../search';
import { now as nowMs, uuid } from '../clock';
import type { AddMessageResult, Artifact, ArtifactType, ConversationState, MessageRow, MetaSnapshot } from '$lib/types/conversation';
import { getResolvedModel, listAllModels } from '../providers/models';
import type { ResolvedModel } from '../providers/types';

import type { MessagePart, ToolCallRecord as RecordedToolCall } from '$lib/types/conversation';

import { runMigrations } from './conversation/migrations';
import { parseJson, normalizeParts, trimTrailingPartialOutput, partsToMessages } from './conversation/parts';
import { buildHistory, buildHistoryWithRowIds } from './conversation/history';
import { resolveReasoningConfig } from './conversation/reasoning';
import { composeSystemPrompt } from './conversation/system-prompt';
import { SubscriberSet } from './conversation/subscribers';
import {
	buildToolRegistry,
	type ConversationContext,
	type McpCache,
} from './conversation/tool-registry-builder';
import { readMessages } from './conversation/state-readers';
import { writeTitle, TITLE_GEN_SYSTEM_PROMPT, TITLE_REGEN_SYSTEM_PROMPT } from './conversation/title-generator';
import { getSandboxPreviewPorts, destroySandbox } from './conversation/sandbox';
import { insertArtifact, type AddArtifactInput } from './conversation/artifacts';

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
			this.#subscribers.broadcast('refresh', {});
			return;
		}

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

	getState(): ConversationState {
		const messages = readMessages(this.#sql);
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
		// Index the user message for full-text search. waitUntil so D1 latency
		// doesn't gate the SSE refresh.
		this.ctx.waitUntil(
			indexSearchMessage(this.env, {
				conversationId,
				messageId: userId,
				role: 'user',
				text: trimmed,
				createdAt: now + 1,
			}).catch(() => {}),
		);
		this.#subscribers.broadcast('refresh', {});

		this.ctx.waitUntil(this.#generate(conversationId, assistantId, model));
		return { status: 'started' };
	}

	async regenerateTitle(conversationId: string): Promise<void> {
		this.#setConversationId(conversationId);
		const history = this.#sql
			.exec(`SELECT role, content FROM messages WHERE ${COMPLETE_PREDICATE} ORDER BY created_at ASC`)
			.toArray() as unknown as Array<{ role: string; content: string }>;
		const transcript = history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
		await writeTitle(
			this.env,
			conversationId,
			transcript.slice(0, 4000),
			{ systemPrompt: TITLE_REGEN_SYSTEM_PROMPT, onlyIfDefault: false },
			{ routeLLM: (id, opts) => this.#routeLLM(id, opts), getContext: () => this.#getContext() },
		);
		this.#subscribers.broadcast('refresh', {});
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
		const trimmed = prompt?.trim() || null;
		await this.env.DB.prepare('UPDATE conversations SET system_prompt = ? WHERE id = ?')
			.bind(trimmed, conversationId)
			.run();
		this.#subscribers.broadcast('refresh', {});
	}

	async setStyle(conversationId: string, styleId: number | null): Promise<void> {
		this.#setConversationId(conversationId);
		const value = styleId != null && styleId > 0 ? Math.floor(styleId) : null;
		await this.env.DB.prepare('UPDATE conversations SET style_id = ? WHERE id = ?')
			.bind(value, conversationId)
			.run();
		this.#subscribers.broadcast('refresh', {});
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
		this.#subscribers.broadcast('refresh', {});
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

		this.#subscribers.broadcast('refresh', {});
		return { compacted: true, droppedCount: rowsToDelete.size };
	}

	// Wipe all DO storage. Cloudflare doesn't expose a "delete this DO from
	// the namespace" API, but `ctx.storage.deleteAll()` drops every row in
	// the SQLite store, so the next time something resolves this DO id it'll
	// be a fresh, empty instance. Pair with `deleteConversation()` in D1 to
	// fully evict a conversation. Closes any live SSE subscribers first so
	// they don't keep streaming on an already-vanished conversation.
	async destroy(): Promise<void> {
		const conversationId = this.#conversationId;
		this.#inProgress = null;
		this.#cancelFlush();
		this.#conversationId = null;
		this.#subscribers.closeAll();
		await this.ctx.storage.deleteAll();
		// Tear down the conversation's sandbox container (best-effort).
		await destroySandbox(this.env, conversationId);
	}

	// -------------------------------------------------------------------------
	// Sandbox helpers
	// -------------------------------------------------------------------------

	async getSandboxPreviewPorts(): Promise<{ port: number; url: string; name?: string }[]> {
		return getSandboxPreviewPorts(this.env, this.#getConversationId());
	}

	async subscribe(): Promise<ReadableStream<Uint8Array>> {
		let storedSub: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number } | null = null;
		const self = this;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				storedSub = { controller, nextId: 1 };
				self.#subscribers.add(storedSub);
				// Tell the browser to wait 3s before reconnecting on a dropped
				// connection, and send the current snapshot so the client can
				// resume without a full page reload.
				controller.enqueue(self.#subscribers.encode('retry: 3000\n\n'));
				self.#sendSync(storedSub);
			},
			cancel() {
				if (storedSub) self.#subscribers.delete(storedSub);
			},
		});

		// If a previous activation died mid-generation, resume now that a
		// client is here to watch. The resume's broadcast events will reach
		// the new subscriber via the normal `#broadcast` path.
		void this.#detectAndResume();

		return stream;
	}

	#sendSync(sub: { controller: ReadableStreamDefaultController<Uint8Array>; nextId: number }): void {
		const messages = readMessages(this.#sql);
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
		this.#subscribers.enqueueTo(sub, 'sync', {
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
				this.#subscribers.broadcast('part', { messageId: assistantId, part: infoPart });
				messages = compaction.messages;
			}

			const [context, convoRow] = await Promise.all([
				this.#getContext(),
				this.env.DB.prepare(
					'SELECT thinking_budget, style_id, system_prompt FROM conversations WHERE id = ?',
				)
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
				thinkingBudget,
				reasoningType: resolved?.model.reasoningType ?? null,
				providerType: resolved?.provider.type ?? null,
			});

			const systemPrompt = composeSystemPrompt({
				conversationOverride: conversationSystemPromptOverride,
				globalSystemPrompt: context.systemPrompt,
				userBio: context.userBio,
				memories: context.memories,
				styles: context.styles,
				conversationStyleId,
			});

			const registry = await buildToolRegistry(this.env, this.#mcpCache, model, context);
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
						this.#subscribers.broadcast('delta', { messageId: assistantId, content: ev.delta });
						this.#scheduleFlush();
					} else if (ev.type === 'thinking_delta') {
						ip.thinking += ev.delta;
						appendThinking(ev.delta);
						this.#subscribers.broadcast('thinking_delta', { messageId: assistantId, content: ev.delta });
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
					const callStartedAt = nowMs();
					parts.push({
						type: 'tool_use',
						id: call.id,
						name: call.name,
						input: call.input,
						thoughtSignature: call.thoughtSignature,
						startedAt: callStartedAt,
					});
					this.#subscribers.broadcast('tool_call', {
						messageId: assistantId,
						id: call.id,
						name: call.name,
						input: call.input,
						thoughtSignature: call.thoughtSignature,
						startedAt: callStartedAt,
					});
					// Seed a preliminary streaming tool_result so the UI shows the
					// call as active while output arrives. Replaced with the final
					// result once execution completes.
					parts.push({
						type: 'tool_result',
						toolUseId: call.id,
						content: '',
						isError: false,
						streaming: true,
						startedAt: callStartedAt,
					});
					this.#subscribers.broadcast('tool_result', {
						messageId: assistantId,
						toolUseId: call.id,
						content: '',
						isError: false,
						streaming: true,
						startedAt: callStartedAt,
					});
					const result = await registry.execute(
						{
							env: this.env,
							conversationId,
							assistantMessageId: assistantId,
							signal,
							emitToolOutput: (chunk: string) => {
								this.#subscribers.broadcast('tool_output', {
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
					const callEndedAt = nowMs();
					// Swap the preliminary streaming part for the final result.
					const partsIdx = parts.findIndex((p) => p.type === 'tool_result' && p.toolUseId === call.id);
					if (partsIdx >= 0) {
						parts[partsIdx] = {
							type: 'tool_result',
							toolUseId: call.id,
							content: result.content,
							isError: result.isError ?? false,
							startedAt: callStartedAt,
							endedAt: callEndedAt,
						};
					} else {
						parts.push({
							type: 'tool_result',
							toolUseId: call.id,
							content: result.content,
							isError: result.isError ?? false,
							startedAt: callStartedAt,
							endedAt: callEndedAt,
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
					this.#subscribers.broadcast('tool_result', {
						messageId: assistantId,
						toolUseId: call.id,
						content: result.content,
						isError: result.isError ?? false,
						startedAt: callStartedAt,
						endedAt: callEndedAt,
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
					this.#sql.exec(
						'UPDATE messages SET model = ?, parts = ? WHERE id = ?',
						currentModel,
						JSON.stringify(parts),
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
						type: 'info',
						text: `Tool iteration budget exhausted (${MAX_TOOL_ITERATIONS} rounds). The model did not produce a final answer; ask a follow-up to continue.`,
					};
					parts.push(infoPart);
					this.#subscribers.broadcast('part', { messageId: assistantId, part: infoPart });
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
			this.#sql.exec(
				`UPDATE messages SET content = ?, status = 'complete', first_token_at = ?, last_chunk_json = ?, usage_json = ?, provider = ?, thinking = ?, parts = ? WHERE id = ?`,
				finalText,
				ip.firstTokenAt || null,
				ip.lastChunk ? JSON.stringify(ip.lastChunk) : null,
				ip.usage ? JSON.stringify(ip.usage) : null,
				llm.providerID,
				finalThinking || null,
				parts.length > 0 ? JSON.stringify(parts) : null,
				assistantId,
			);
			this.#inProgress = null;
			await this.env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(nowMs(), conversationId).run();
			this.ctx.waitUntil(
				indexSearchMessage(this.env, {
					conversationId,
					messageId: assistantId,
					role: 'assistant',
					text: finalText,
					createdAt: ip.startedAt || nowMs(),
				}).catch(() => {}),
			);
			this.#subscribers.broadcast('meta', {
				messageId: assistantId,
				snapshot: { startedAt: ip.startedAt, firstTokenAt: ip.firstTokenAt, lastChunk: ip.lastChunk, usage: ip.usage },
			});
			if (accumulatedCitations.length > 0) {
				this.#subscribers.broadcast('citations', { messageId: assistantId, citations: accumulatedCitations });
			}
			this.#subscribers.broadcast('refresh', {});
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
			this.#subscribers.broadcast('refresh', {});
		}
	}

	// Per-turn snapshot of the static-ish D1 config (settings + sub-agents
	// + mcp servers + provider models). Cached per-DO with a 30s TTL so a
	// chat turn issues at most one round of fetches instead of ~10.
	async #getContext(): Promise<ConversationContext> {
		const cached = this.#contextCache;
		if (cached && nowMs() - cached.fetchedAt < CONTEXT_CACHE_TTL_MS) return cached.context;
		const [systemPrompt, userBio, allModels, subAgents, mcpServers, memories, styles] = await Promise.all([
			getSystemPrompt(this.env),
			getUserBio(this.env),
			listAllModels(this.env),
			listSubAgents(this.env),
			listMcpServers(this.env),
			listMemories(this.env),
			listStyles(this.env),
		]);
		const context: ConversationContext = {
			systemPrompt,
			userBio,
			allModels,
			subAgents,
			mcpServers,
			memories,
			styles,
		};
		this.#contextCache = { fetchedAt: nowMs(), context };
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
				{ systemPrompt: TITLE_GEN_SYSTEM_PROMPT, onlyIfDefault: true },
				{ routeLLM: (id, opts) => this.#routeLLM(id, opts), getContext: () => this.#getContext() },
			),
		);
	}
}
