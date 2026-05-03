import { DurableObject } from 'cloudflare:workers';
import { OpenRouter } from '@openrouter/sdk';
import type { ChatMessages, ChatStreamChunk, ChatUsage, GenerationResponseData } from '@openrouter/sdk/esm/models';
import { OpenRouterLLM } from '../llm/OpenRouterLLM';
import type { MetaSnapshot } from '../frontend/meta';

export type MessageRow = {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	model: string | null;
	status: 'complete' | 'streaming' | 'error';
	error: string | null;
	createdAt: number;
	meta: MetaSnapshot | null;
};

export type ConversationState = {
	messages: MessageRow[];
	inProgress: { messageId: string; content: string } | null;
};

export type AddMessageResult = { status: 'started' } | { status: 'busy' } | { status: 'invalid'; reason: string };

const PING_INTERVAL_MS = 25_000;
const TITLE_MAX = 60;

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

export default class ConversationDurableObject extends DurableObject<Env> {
	#client: OpenRouter;
	#sql: SqlStorage;
	#subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	#inProgress: { messageId: string; content: string } | null = null;
	#pingInterval: ReturnType<typeof setInterval> | null = null;
	#encoder = new TextEncoder();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#client = new OpenRouter({
			apiKey: env.OPENROUTER_KEY,
			httpReferer: 'https://github.com/piperswe/interface',
			appTitle: 'Interface',
		});
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
					generation_json TEXT
				)
			`);
			// Idempotent ALTERs for existing DOs created before the telemetry columns existed.
			for (const stmt of [
				'ALTER TABLE messages ADD COLUMN started_at INTEGER',
				'ALTER TABLE messages ADD COLUMN first_token_at INTEGER',
				'ALTER TABLE messages ADD COLUMN last_chunk_json TEXT',
				'ALTER TABLE messages ADD COLUMN usage_json TEXT',
				'ALTER TABLE messages ADD COLUMN generation_json TEXT',
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

		this.#sql.exec('UPDATE messages SET started_at = ? WHERE id = ?', startedAt, assistantId);

		try {
			const llm = new OpenRouterLLM(this.#client, model, 'openrouter');
			const history = this.#sql
				.exec("SELECT role, content FROM messages WHERE id != ? AND status = 'complete' ORDER BY created_at ASC", assistantId)
				.toArray() as unknown as Array<{ role: string; content: string }>;
			const messages: ChatMessages[] = history.map((m) =>
				m.role === 'assistant' ? { role: 'assistant' as const, content: m.content } : { role: 'user' as const, content: m.content },
			);

			const stream = llm.chatCompletionsStream({ messages });
			for await (const chunk of stream) {
				lastChunk = chunk;
				if (chunk?.usage) usage = chunk.usage;
				const delta = chunk?.choices?.[0]?.delta?.content ?? '';
				if (!delta) continue;
				if (!firstTokenAt) firstTokenAt = Date.now();
				if (this.#inProgress && this.#inProgress.messageId === assistantId) {
					this.#inProgress.content += delta;
				}
				this.#broadcast('delta', { messageId: assistantId, content: delta });
			}

			const final = this.#inProgress?.content ?? '';
			this.#sql.exec(
				"UPDATE messages SET content = ?, status = 'complete', first_token_at = ?, last_chunk_json = ?, usage_json = ? WHERE id = ?",
				final,
				firstTokenAt || null,
				lastChunk ? JSON.stringify(lastChunk) : null,
				usage ? JSON.stringify(usage) : null,
				assistantId,
			);
			this.#inProgress = null;
			await this.env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(Date.now(), conversationId).run();
			this.#broadcast('meta', {
				messageId: assistantId,
				snapshot: { startedAt, firstTokenAt, lastChunk, usage, generation: null },
			});
			this.#broadcast('refresh', {});

			if (lastChunk?.id) {
				this.ctx.waitUntil(this.#fetchGenerationStats(assistantId, lastChunk.id, startedAt, firstTokenAt, lastChunk, usage));
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

	#readMessages(): MessageRow[] {
		const rows = this.#sql
			.exec(
				`SELECT id, role, content, model, status, error, created_at, started_at, first_token_at, last_chunk_json, usage_json, generation_json FROM messages ORDER BY created_at ASC`,
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
		}>;
		return rows.map((r) => ({
			id: r.id,
			role: r.role as 'user' | 'assistant',
			content: r.content,
			model: r.model,
			status: r.status as 'complete' | 'streaming' | 'error',
			error: r.error,
			createdAt: r.created_at,
			meta: this.#deriveMeta(r.started_at, r.first_token_at, r.last_chunk_json, r.usage_json, r.generation_json),
		}));
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
		// Generation stats are not always available immediately after the stream completes.
		// Retry with backoff: 1s, 2s, 4s, 8s, 16s.
		const delays = [1000, 2000, 4000, 8000, 16000];
		for (const delay of delays) {
			await new Promise((resolve) => setTimeout(resolve, delay));
			try {
				const response = await this.#client.generations.getGeneration({ id: generationId });
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
		const candidateTitle = this.#deriveTitle(firstMessageContent);
		await this.env.DB.prepare(
			`UPDATE conversations
				SET updated_at = ?,
					title = CASE WHEN title = 'New conversation' THEN ? ELSE title END
				WHERE id = ?`,
		)
			.bind(now, candidateTitle, conversationId)
			.run();
	}

	#deriveTitle(content: string): string {
		const collapsed = content.replace(/\s+/g, ' ').trim();
		if (collapsed.length <= TITLE_MAX) return collapsed;
		return collapsed.slice(0, TITLE_MAX).trimEnd() + '…';
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
