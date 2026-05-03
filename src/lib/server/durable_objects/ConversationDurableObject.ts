import { DurableObject } from 'cloudflare:workers';
import { OpenRouter } from '@openrouter/sdk';
import type { ChatStreamChunk, ChatUsage, GenerationResponseData } from '@openrouter/sdk/models';
import { routeLLM } from '../llm/route';
import { compactHistory } from '../llm/context';
import type { ChatRequest, ContentBlock, Message, StreamEvent, ToolDefinition, Usage } from '../llm/LLM';
import { ToolRegistry } from '../tools/registry';
import type { ToolCitation } from '../tools/registry';
import { fetchUrlTool } from '../tools/fetch_url';
import { createWebSearchTool } from '../tools/web_search';
import { KagiSearchBackend } from '../search/kagi';
import { McpHttpClient } from '../mcp/client';
import { listMcpServers } from '../mcp_servers';
import { getSystemPrompt, getUserBio } from '../settings';
import type { AddMessageResult, Artifact, ArtifactType, ConversationState, MessageRow, MetaSnapshot } from '$lib/types/conversation';

export type { AddMessageResult, Artifact, ArtifactType, ConversationState, MessageRow, MetaSnapshot };

const PING_INTERVAL_MS = 25_000;
const TITLE_MAX = 60;
const MAX_TOOL_ITERATIONS = 10;
const TITLE_MODEL = 'google/gemma-4-31b-it:free';

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

// Reconstruct an ordered parts timeline for messages persisted before the
// `parts` column existed. We don't know the original interleaving — fall back
// to "all text first, then all tool_use, then all tool_result". Anyone who
// chats with the upgraded DO will get true ordering on subsequent turns.
function buildLegacyParts(
	content: string,
	toolCalls: RecordedToolCall[],
	toolResults: RecordedToolResult[],
	thinking: string | null,
): MessagePart[] {
	const parts: MessagePart[] = [];
	if (thinking) parts.push({ type: 'thinking', text: thinking });
	if (content) parts.push({ type: 'text', text: content });
	for (const tc of toolCalls) parts.push({ type: 'tool_use', ...tc });
	for (const tr of toolResults) {
		parts.push({ type: 'tool_result', toolUseId: tr.toolUseId, content: tr.content, isError: tr.isError });
	}
	return parts;
}

function formatLLMError(e: unknown): string {
	if (e instanceof Error && e.message) return e.message.slice(0, 500);
	if (typeof e === 'object' && e !== null) {
		try {
			return JSON.stringify(e).slice(0, 500);
		} catch {
			/* fall through */
		}
	}
	return String(e).slice(0, 500);
}

function usageToOpenRouter(usage: Usage): ChatUsage {
	return {
		promptTokens: usage.inputTokens,
		completionTokens: usage.outputTokens,
		totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
		...(usage.cacheReadInputTokens != null || usage.cacheCreationInputTokens != null
			? {
					promptTokensDetails: {
						...(usage.cacheReadInputTokens != null ? { cachedTokens: usage.cacheReadInputTokens } : {}),
						...(usage.cacheCreationInputTokens != null ? { cacheWriteTokens: usage.cacheCreationInputTokens } : {}),
					},
				}
			: {}),
		...(usage.thinkingTokens != null
			? { completionTokensDetails: { reasoningTokens: usage.thinkingTokens } }
			: {}),
	};
}

export default class ConversationDurableObject extends DurableObject<Env> {
	#sql: SqlStorage;
	#subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	#inProgress: { messageId: string; content: string } | null = null;
	#pingInterval: ReturnType<typeof setInterval> | null = null;
	#encoder = new TextEncoder();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.#sql.exec(`
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
			this.#sql.exec(`
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
			for (const stmt of ['ALTER TABLE artifacts ADD COLUMN language TEXT']) {
				try {
					this.#sql.exec(stmt);
				} catch {
					// column already exists
				}
			}
			this.#sql.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id)`);
			// Idempotent ALTERs for existing DOs that pre-date these columns.
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
				try {
					this.#sql.exec(stmt);
				} catch {
					// column already exists
				}
			}
			this.#sql.exec("UPDATE messages SET status = 'error', error = 'Generation interrupted' WHERE status = 'streaming'");
		});
	}

	getState(): ConversationState {
		const messages = this.#readMessages();
		if (this.#inProgress) {
			const inProgressId = this.#inProgress.messageId;
			const partial = this.#inProgress.content;
			const merged = messages.map((m) => (m.id === inProgressId ? { ...m, content: partial } : m));
			return { messages: merged, inProgress: { ...this.#inProgress } };
		}
		return { messages, inProgress: null };
	}

	async addUserMessage(conversationId: string, content: string, model: string): Promise<AddMessageResult> {
		if (this.#inProgress) return { status: 'busy' };
		const trimmed = content.trim();
		if (!trimmed) return { status: 'invalid', reason: 'empty' };
		if (!model) return { status: 'invalid', reason: 'missing model' };

		const now = Date.now();
		const userId = crypto.randomUUID();
		const assistantId = crypto.randomUUID();

		this.#sql.exec(
			"INSERT INTO messages (id, role, content, model, status, created_at) VALUES (?, 'user', ?, NULL, 'complete', ?)",
			userId,
			trimmed,
			now,
		);
		this.#sql.exec(
			"INSERT INTO messages (id, role, content, model, status, created_at) VALUES (?, 'assistant', '', ?, 'streaming', ?)",
			assistantId,
			model,
			now + 1,
		);

		this.#inProgress = { messageId: assistantId, content: '' };

		await this.#touchConversation(conversationId, trimmed);
		this.#broadcast('refresh', {});

		this.ctx.waitUntil(this.#generate(conversationId, assistantId, model));
		return { status: 'started' };
	}

	async regenerateTitle(conversationId: string): Promise<void> {
		const history = this.#sql
			.exec(
				"SELECT role, content FROM messages WHERE status = 'complete' AND deleted_at IS NULL ORDER BY created_at ASC",
			)
			.toArray() as unknown as Array<{ role: string; content: string }>;
		const transcript = history
			.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
			.join('\n\n');
		const collapsed = transcript.replace(/\s+/g, ' ').trim();
		try {
			const llm = routeLLM(this.env, TITLE_MODEL);
			let title = '';
			for await (const ev of llm.chat({
				messages: [
					{
						role: 'system',
						content:
							'You are a title generator. Given a conversation transcript, generate a short, clear, descriptive title (2-6 words) that summarises the overall topic or intent. Reply with the title only — no quotes, no explanation.',
					},
					{ role: 'user', content: collapsed.slice(0, 4000) },
				],
				maxTokens: 30,
				temperature: 0.5,
			})) {
				if (ev.type === 'text_delta') title += ev.delta;
				if (ev.type === 'error') throw new Error(ev.message);
			}
			title = title.trim().replace(/^"|"$/g, '').slice(0, TITLE_MAX);
			if (!title) throw new Error('empty title from LLM');
			await this.env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(title, conversationId).run();
		} catch (e) {
			const fallback = collapsed.length <= TITLE_MAX ? collapsed : collapsed.slice(0, TITLE_MAX).trimEnd() + '…';
			await this.env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(fallback, conversationId).run();
		}
		this.#broadcast('refresh', {});
	}

	async setThinkingBudget(conversationId: string, budget: number | null): Promise<void> {
		// Per-conversation thinking token budget. AnthropicLLM honors this when
		// the model supports extended thinking; OpenRouterLLM ignores it.
		const value = budget != null && budget > 0 ? Math.floor(budget) : null;
		await this.env.DB.prepare('UPDATE conversations SET thinking_budget = ? WHERE id = ?')
			.bind(value, conversationId)
			.run();
	}

	async subscribe(): Promise<ReadableStream<Uint8Array>> {
		let storedController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const self = this;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				storedController = controller;
				self.#subscribers.add(controller);
				self.#startPingIfNeeded();
				self.#sendSync(controller);
			},
			cancel() {
				if (storedController) self.#subscribers.delete(storedController);
				self.#stopPingIfEmpty();
			},
		});

		return stream;
	}

	#sendSync(controller: ReadableStreamDefaultController<Uint8Array>): void {
		const messages = this.#readMessages();
		const last = messages[messages.length - 1];
		if (!last) return;
		const content = this.#inProgress && this.#inProgress.messageId === last.id ? this.#inProgress.content : last.content;
		this.#enqueueTo(controller, 'sync', {
			lastMessageId: last.id,
			lastMessageStatus: last.status,
			lastMessageContent: content,
		});
	}

	async #generate(conversationId: string, assistantId: string, model: string): Promise<void> {
		const startedAt = Date.now();
		let firstTokenAt = 0;
		let lastChunk: ChatStreamChunk | null = null;
		let usage: ChatUsage | null = null;
		let thinkingText = '';
		let lastGenerationId: string | null = null;

		const accumulatedToolCalls: RecordedToolCall[] = [];
		const accumulatedToolResults: RecordedToolResult[] = [];
		const accumulatedCitations: ToolCitation[] = [];
		// Ordered timeline of the turn: text segments interleaved with tool
		// invocations and their results in the sequence the model produced
		// them. Mirrors the order of broadcast SSE events.
		const parts: MessagePart[] = [];
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

		this.#sql.exec('UPDATE messages SET started_at = ? WHERE id = ?', startedAt, assistantId);

		try {
			const llm = routeLLM(this.env, model);
			const history = this.#sql
				.exec(
					"SELECT role, content FROM messages WHERE id != ? AND status = 'complete' AND deleted_at IS NULL ORDER BY created_at ASC",
					assistantId,
				)
				.toArray() as unknown as Array<{ role: string; content: string }>;
			let messages: Message[] = history.map((m) => ({
				role: m.role === 'assistant' ? 'assistant' : 'user',
				content: m.content,
			}));

			// Check whether we need to compact context before sending.
			const lastUsageRow = this.#sql
				.exec(
					"SELECT usage_json FROM messages WHERE role = 'assistant' AND status = 'complete' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
				)
				.toArray() as unknown as Array<{ usage_json: string | null }>;
			const lastUsage = lastUsageRow[0]?.usage_json
				? (parseJson<{ promptTokens: number; inputTokens?: number }>(lastUsageRow[0].usage_json) ?? null)
				: null;
			const usageForCompaction = lastUsage
				? { inputTokens: lastUsage.inputTokens ?? lastUsage.promptTokens }
				: null;
			const compaction = await compactHistory(messages, model, this.env, usageForCompaction);
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

			const DEFAULT_SYSTEM_PROMPT =
				'You are Interface, an AI agent designed to serve as an interface between users and complex computer systems.';

			const [convoRow, rawSystemPrompt, userBio] = await Promise.all([
				this.env.DB.prepare('SELECT thinking_budget FROM conversations WHERE id = ?')
					.bind(conversationId)
					.first<{ thinking_budget: number | null }>(),
				getSystemPrompt(this.env),
				getUserBio(this.env),
			]);
			const thinkingBudget = convoRow?.thinking_budget ?? null;
			const thinking: ChatRequest['thinking'] | undefined =
				thinkingBudget && thinkingBudget > 0 ? { type: 'enabled', budgetTokens: thinkingBudget } : undefined;

			const effectiveSystemPrompt = rawSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
			const systemPrompt = userBio
				? `${effectiveSystemPrompt}\n\nUser bio:\n${userBio}`
				: effectiveSystemPrompt;

			const registry = await this.#buildToolRegistry();
			const tools: ToolDefinition[] | undefined =
				registry.definitions().length > 0 ? registry.definitions() : undefined;

			for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
				const turnToolCalls: RecordedToolCall[] = [];
				let turnText = '';
				let providerError: string | null = null;

				for await (const ev of llm.chat({
					messages,
					systemPrompt,
					...(tools ? { tools } : {}),
					...(thinking ? { thinking } : {}),
				})) {
					if (ev.type === 'text_delta') {
						if (!firstTokenAt) firstTokenAt = Date.now();
						turnText += ev.delta;
						appendText(ev.delta);
						if (this.#inProgress && this.#inProgress.messageId === assistantId) {
							this.#inProgress.content += ev.delta;
						}
						this.#broadcast('delta', { messageId: assistantId, content: ev.delta });
					} else if (ev.type === 'thinking_delta') {
						thinkingText += ev.delta;
						appendThinking(ev.delta);
						this.#broadcast('thinking_delta', { messageId: assistantId, content: ev.delta });
					} else if (ev.type === 'tool_call') {
						turnToolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
					} else if (ev.type === 'usage') {
						usage = usageToOpenRouter(ev.usage);
					} else if (ev.type === 'done') {
						if (ev.raw && typeof ev.raw === 'object' && 'choices' in ev.raw) {
							lastChunk = ev.raw as ChatStreamChunk;
							if (lastChunk.id) lastGenerationId = lastChunk.id;
						}
					} else if (ev.type === 'error') {
						providerError = ev.message;
					}
				}

				if (providerError) throw new Error(providerError);

				if (turnToolCalls.length === 0) break;

				accumulatedToolCalls.push(...turnToolCalls);

				// Build the assistant message that triggered these tool calls.
				const assistantBlocks: ContentBlock[] = [];
				if (turnText) assistantBlocks.push({ type: 'text', text: turnText });
				for (const tc of turnToolCalls) {
					assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
				}
				messages.push({ role: 'assistant', content: assistantBlocks });

				// Execute each tool, broadcast call+result events, append result to history.
				for (const call of turnToolCalls) {
					parts.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
					this.#broadcast('tool_call', {
						messageId: assistantId,
						id: call.id,
						name: call.name,
						input: call.input,
					});
					const result = await registry.execute(
						{ env: this.env, conversationId, assistantMessageId: assistantId },
						call.name,
						call.input,
					);
					const resultRecord: RecordedToolResult = {
						toolUseId: call.id,
						content: result.content,
						isError: result.isError ?? false,
					};
					accumulatedToolResults.push(resultRecord);
					parts.push({
						type: 'tool_result',
						toolUseId: call.id,
						content: result.content,
						isError: result.isError ?? false,
					});
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
			}

			const finalText = this.#inProgress?.content ?? '';
			this.#sql.exec(
				`UPDATE messages SET content = ?, status = 'complete', first_token_at = ?, last_chunk_json = ?, usage_json = ?, provider = ?, thinking = ?, tool_calls = ?, tool_results = ?, parts = ? WHERE id = ?`,
				finalText,
				firstTokenAt || null,
				lastChunk ? JSON.stringify(lastChunk) : null,
				usage ? JSON.stringify(usage) : null,
				llm.providerID,
				thinkingText || null,
				accumulatedToolCalls.length > 0 ? JSON.stringify(accumulatedToolCalls) : null,
				accumulatedToolResults.length > 0 ? JSON.stringify(accumulatedToolResults) : null,
				parts.length > 0 ? JSON.stringify(parts) : null,
				assistantId,
			);
			this.#inProgress = null;
			await this.env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
				.bind(Date.now(), conversationId)
				.run();
			this.#broadcast('meta', {
				messageId: assistantId,
				snapshot: { startedAt, firstTokenAt, lastChunk, usage, generation: null },
			});
			if (accumulatedCitations.length > 0) {
				this.#broadcast('citations', { messageId: assistantId, citations: accumulatedCitations });
			}
			this.#broadcast('refresh', {});

			if (lastGenerationId && llm.providerID === 'openrouter') {
				this.ctx.waitUntil(
					this.#fetchGenerationStats(assistantId, lastGenerationId, startedAt, firstTokenAt, lastChunk, usage),
				);
			}
		} catch (e) {
			const msg = formatLLMError(e);
			const partial = this.#inProgress?.content ?? '';
			this.#sql.exec(
				"UPDATE messages SET content = ?, status = 'error', error = ?, first_token_at = ?, last_chunk_json = ?, usage_json = ? WHERE id = ?",
				partial,
				msg,
				firstTokenAt || null,
				lastChunk ? JSON.stringify(lastChunk) : null,
				usage ? JSON.stringify(usage) : null,
				assistantId,
			);
			this.#inProgress = null;
			this.#broadcast('refresh', {});
		}
	}

	async #buildToolRegistry(): Promise<ToolRegistry> {
		const registry = new ToolRegistry();
		registry.register(fetchUrlTool);
		if (this.env.KAGI_KEY) {
			registry.register(createWebSearchTool(new KagiSearchBackend(this.env.KAGI_KEY)));
		}
		// Register HTTP/SSE MCP tools. Stdio transport waits for Phase 0.6 (Sandbox).
		try {
			const servers = await listMcpServers(this.env);
			for (const server of servers) {
				if (!server.enabled) continue;
				if ((server.transport === 'http' || server.transport === 'sse') && server.url) {
					await this.#registerMcpServerTools(registry, server.id, server.name, server.url, server.authJson);
				}
			}
		} catch {
			// Tool registry build is best-effort — MCP enumeration failures must not
			// block the user's chat turn. Server failures surface per-call instead.
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
			const client = new McpHttpClient({ url, authJson });
			const tools = await client.listTools();
			for (const tool of tools) {
				const namespacedName = `mcp_${serverId}_${tool.name}`;
				registry.register({
					definition: {
						name: namespacedName,
						description: tool.description ?? `${serverName}: ${tool.name}`,
						inputSchema: tool.inputSchema ?? { type: 'object' },
					},
					async execute(_ctx, input) {
						const callClient = new McpHttpClient({ url, authJson });
						try {
							const result = await callClient.callTool(tool.name, input);
							const text = result.content
								.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
								.join('\n');
							return { content: text, ...(result.isError ? { isError: true } : {}) };
						} catch (e) {
							return { content: e instanceof Error ? e.message : String(e), isError: true };
						}
					},
				});
			}
		} catch {
			// Server unreachable during enumeration — skip.
		}
	}

	#readMessages(): MessageRow[] {
		const rows = this.#sql
			.exec(
				`SELECT id, role, content, model, status, error, created_at, started_at, first_token_at, last_chunk_json, usage_json, generation_json, thinking, tool_calls, tool_results, parts
				 FROM messages
				 WHERE deleted_at IS NULL
				 ORDER BY created_at ASC`,
			)
			.toArray() as unknown as Array<{
			id: string;
			role: string;
			content: string;
			model: string | null;
			status: string;
			error: string | null;
			created_at: number;
			started_at: number | null;
			first_token_at: number | null;
			last_chunk_json: string | null;
			usage_json: string | null;
			generation_json: string | null;
			thinking: string | null;
			tool_calls: string | null;
			tool_results: string | null;
			parts: string | null;
		}>;
		const artifactsByMessage = this.#readArtifactsByMessage();
		return rows.map((r) => {
			const toolCalls = parseJson<RecordedToolCall[]>(r.tool_calls) ?? [];
			const toolResults = parseJson<RecordedToolResult[]>(r.tool_results) ?? [];
			const parts =
				parseJson<MessagePart[]>(r.parts) ?? buildLegacyParts(r.content, toolCalls, toolResults, r.thinking);
			return {
				id: r.id,
				role: r.role as 'user' | 'assistant',
				content: r.content,
				thinking: r.thinking,
				model: r.model,
				status: r.status as 'complete' | 'streaming' | 'error',
				error: r.error,
				createdAt: r.created_at,
				meta: this.#deriveMeta(r.started_at, r.first_token_at, r.last_chunk_json, r.usage_json, r.generation_json),
				artifacts: artifactsByMessage.get(r.id) ?? [],
				toolCalls,
				toolResults,
				parts,
			};
		});
	}

	#readArtifactsByMessage(): Map<string, Artifact[]> {
		const rows = this.#sql
			.exec(
				`SELECT id, message_id, type, name, language, version, content, created_at FROM artifacts ORDER BY created_at ASC`,
			)
			.toArray() as unknown as Array<{
			id: string;
			message_id: string;
			type: string;
			name: string | null;
			language: string | null;
			version: number;
			content: string;
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
		const id = crypto.randomUUID();
		const now = Date.now();
		const versionRow = this.#sql
			.exec('SELECT MAX(version) AS v FROM artifacts WHERE message_id = ?', input.messageId)
			.toArray() as unknown as Array<{ v: number | null }>;
		const version = (versionRow[0]?.v ?? 0) + 1;
		this.#sql.exec(
			`INSERT INTO artifacts (id, message_id, type, name, language, version, content, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			input.messageId,
			input.type,
			input.name ?? null,
			input.language ?? null,
			version,
			input.content,
			now,
		);
		// Update artifact_ids on the parent message.
		const existing = this.#sql
			.exec('SELECT artifact_ids FROM messages WHERE id = ?', input.messageId)
			.toArray() as unknown as Array<{ artifact_ids: string | null }>;
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
		generationJson: string | null,
	): MetaSnapshot | null {
		if (!startedAt && !lastChunkJson && !usageJson && !generationJson) return null;
		let lastChunk: ChatStreamChunk | null = null;
		let usage: ChatUsage | null = null;
		let generation: GenerationResponseData | null = null;
		try {
			if (lastChunkJson) lastChunk = JSON.parse(lastChunkJson) as ChatStreamChunk;
		} catch {
			/* keep null */
		}
		try {
			if (usageJson) usage = JSON.parse(usageJson) as ChatUsage;
		} catch {
			/* keep null */
		}
		try {
			if (generationJson) generation = JSON.parse(generationJson) as GenerationResponseData;
		} catch {
			/* keep null */
		}
		return {
			startedAt: startedAt ?? 0,
			firstTokenAt: firstTokenAt ?? 0,
			lastChunk,
			usage,
			generation,
		};
	}

	async #fetchGenerationStats(
		assistantId: string,
		generationId: string,
		startedAt: number,
		firstTokenAt: number,
		lastChunk: ChatStreamChunk | null,
		usage: ChatUsage | null,
	): Promise<void> {
		// Generation stats are not always available immediately after the stream
		// completes. Retry with backoff.
		const client = new OpenRouter({
			apiKey: this.env.OPENROUTER_KEY,
			httpReferer: 'https://github.com/piperswe/interface',
			appTitle: 'Interface',
		});
		const delays = [1000, 2000, 4000, 8000, 16000];
		for (const delay of delays) {
			await new Promise((resolve) => setTimeout(resolve, delay));
			try {
				const response = await client.generations.getGeneration({ id: generationId });
				const generation = response.data;
				if (!generation) continue;
				this.#sql.exec('UPDATE messages SET generation_json = ? WHERE id = ?', JSON.stringify(generation), assistantId);
				this.#broadcast('meta', {
					messageId: assistantId,
					snapshot: { startedAt, firstTokenAt, lastChunk, usage, generation },
				});
				return;
			} catch {
				// 404 / not yet available — try again
			}
		}
	}

	async #touchConversation(conversationId: string, firstMessageContent: string): Promise<void> {
		const now = Date.now();
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
		const collapsed = firstMessageContent.replace(/\s+/g, ' ').trim();
		try {
			const llm = routeLLM(this.env, TITLE_MODEL);
			let title = '';
			for await (const ev of llm.chat({
				messages: [
					{
						role: 'system',
						content: 'You are a title generator. Given the user message, generate a short, clear, descriptive title (2-6 words) that summarises its topic or intent. Reply with the title only — no quotes, no explanation.',
					},
					{ role: 'user', content: collapsed },
				],
				maxTokens: 30,
				temperature: 0.5,
			})) {
				if (ev.type === 'text_delta') title += ev.delta;
				if (ev.type === 'error') throw new Error(ev.message);
			}
			title = title.trim().replace(/^"|"$/g, '').slice(0, TITLE_MAX);
			if (!title) throw new Error('empty title from LLM');
			await this.env.DB.prepare(
				`UPDATE conversations
					SET title = CASE WHEN title = 'New conversation' THEN ? ELSE title END
					WHERE id = ?`,
			)
				.bind(title, conversationId)
				.run();
		} catch (e) {
			// Fall back to truncation on any error.
			const fallback = collapsed.length <= TITLE_MAX ? collapsed : collapsed.slice(0, TITLE_MAX).trimEnd() + '…';
			await this.env.DB.prepare(
				`UPDATE conversations
					SET title = CASE WHEN title = 'New conversation' THEN ? ELSE title END
					WHERE id = ?`,
			)
				.bind(fallback, conversationId)
				.run();
		}
	}

	#sseFrame(event: string, data: unknown): Uint8Array {
		return this.#encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}

	#enqueueTo(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): boolean {
		try {
			controller.enqueue(this.#sseFrame(event, data));
			return true;
		} catch {
			this.#subscribers.delete(controller);
			return false;
		}
	}

	#broadcast(event: string, data: unknown): void {
		if (this.#subscribers.size === 0) return;
		const frame = this.#sseFrame(event, data);
		const dead: ReadableStreamDefaultController<Uint8Array>[] = [];
		for (const controller of this.#subscribers) {
			try {
				controller.enqueue(frame);
			} catch {
				dead.push(controller);
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
			const dead: ReadableStreamDefaultController<Uint8Array>[] = [];
			for (const controller of this.#subscribers) {
				try {
					controller.enqueue(frame);
				} catch {
					dead.push(controller);
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
