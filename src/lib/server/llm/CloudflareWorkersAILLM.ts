import type LLM from './LLM';
import type {
	ChatRequest,
	ContentBlock,
	Message,
	StreamEvent,
	ToolDefinition,
} from './LLM';
import { formatError } from './errors';

// Cloudflare Workers AI adapter. Uses the `env.AI` binding's `run()` method
// against `@cf/...` models. When a Gateway slug is provided, the binding
// re-routes through AI Gateway for analytics/caching. Workers AI is *not*
// covered by AI Gateway Unified Billing — `@cf/` models always bill against
// Workers AI Neurons.
//
// Streaming format: Workers AI emits SSE with two possible JSON shapes per
// `data:` line, depending on the model:
//   - Native shape:  { response: "...delta...", usage?: {...}, tool_calls?: [...] }
//   - OpenAI-compat: { choices: [{ delta: { content, tool_calls? }, finish_reason? }],
//                      usage?: {...} }
// gpt-oss models emit the OpenAI-compat shape; Llama / Mistral / Qwen / Gemma
// chat models emit the native shape. The parser below detects per-chunk and
// maps both into the unified StreamEvent vocabulary.

const DEFAULT_MAX_TOKENS = 4096;

type CfChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<{ type: string; [k: string]: unknown }> | null;
	tool_call_id?: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
};

type CfTool = {
	type: 'function';
	function: { name: string; description: string; parameters: object };
};

type CfRunOptions = { gateway?: { id: string } };

type CfChunk = {
	response?: string;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
	tool_calls?: Array<{
		id?: string;
		name?: string;
		arguments?: unknown;
	}>;
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
};

export class CloudflareWorkersAILLM implements LLM {
	#ai: Ai;
	model: string;
	providerID: string;
	#gatewayId: string | null;

	constructor(ai: Ai, model: string, gatewayId: string | null = null, providerID = 'cloudflare-workers-ai') {
		this.#ai = ai;
		this.model = model;
		this.#gatewayId = gatewayId;
		this.providerID = providerID;
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		try {
			const messages = toCfMessages(request.systemPrompt, request.messages);
			const tools = request.tools && request.tools.length > 0 ? toCfTools(request.tools) : undefined;
			const params: Record<string, unknown> = {
				messages,
				stream: true,
				max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
			};
			if (tools) params.tools = tools;
			if (request.temperature !== undefined) params.temperature = request.temperature;

			const opts: CfRunOptions | undefined = this.#gatewayId
				? { gateway: { id: this.#gatewayId } }
				: undefined;

			// The `Ai.run` overload signatures don't expose a generic for chat
			// models with `stream: true`, but the runtime always returns a
			// `ReadableStream<Uint8Array>` for that combo.
			const result = (await (this.#ai as unknown as {
				run: (m: string, p: unknown, o?: CfRunOptions) => Promise<ReadableStream<Uint8Array>>;
			}).run(this.model, params, opts)) as ReadableStream<Uint8Array>;

			yield* parseWorkersAIStream(result, request.signal);
		} catch (e) {
			yield { type: 'error', message: formatError(e) };
		}
	}
}

async function* parseWorkersAIStream(
	stream: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
): AsyncIterable<StreamEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const partialToolCalls = new Map<number, { id: string; name: string; args: string }>();
	let usageEmitted = false;
	let stopReason: string | null = null;

	const onAbort = () => {
		try {
			void reader.cancel('aborted');
		} catch {
			// ignore
		}
	};
	if (signal) signal.addEventListener('abort', onAbort);

	try {
		while (true) {
			if (signal?.aborted) break;
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// SSE events are separated by blank lines. Process complete events;
			// keep any trailing partial in the buffer.
			let sep: number;
			while ((sep = buffer.indexOf('\n\n')) !== -1) {
				const rawEvent = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const dataLine = extractData(rawEvent);
				if (dataLine == null) continue;
				if (dataLine === '[DONE]') {
					yield* finalizeToolCalls(partialToolCalls);
					yield { type: 'done', ...(stopReason ? { finishReason: stopReason } : {}) };
					return;
				}
				let chunk: CfChunk;
				try {
					chunk = JSON.parse(dataLine) as CfChunk;
				} catch {
					continue;
				}

				// OpenAI-compat shape (gpt-oss family)
				if (chunk.choices && chunk.choices.length > 0) {
					const choice = chunk.choices[0];
					const delta = choice.delta;
					if (delta?.content) yield { type: 'text_delta', delta: delta.content };
					if (delta?.reasoning_content) yield { type: 'thinking_delta', delta: delta.reasoning_content };
					if (delta?.tool_calls) {
						for (const tc of delta.tool_calls) {
							const existing = partialToolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
							if (tc.id) existing.id = tc.id;
							if (tc.function?.name) existing.name = tc.function.name;
							if (tc.function?.arguments) existing.args += tc.function.arguments;
							partialToolCalls.set(tc.index, existing);
							yield {
								type: 'tool_call_delta',
								id: existing.id,
								...(tc.function?.name ? { name: tc.function.name } : {}),
								...(tc.function?.arguments ? { argumentsDelta: tc.function.arguments } : {}),
							};
						}
					}
					if (choice.finish_reason) stopReason = choice.finish_reason;
				}

				// Native Workers AI shape
				if (chunk.response) {
					yield { type: 'text_delta', delta: chunk.response };
				}
				if (chunk.tool_calls && chunk.tool_calls.length > 0) {
					// Native shape emits tool calls as a complete array on a final chunk.
					for (let i = 0; i < chunk.tool_calls.length; i++) {
						const tc = chunk.tool_calls[i];
						const id = tc.id ?? `cf_tool_${i}`;
						const name = tc.name ?? '';
						let input: unknown = tc.arguments ?? {};
						if (typeof input === 'string') {
							try {
								input = JSON.parse(input);
							} catch {
								input = { _raw: input };
							}
						}
						if (!name) continue;
						yield { type: 'tool_call_delta', id, name };
						yield { type: 'tool_call', id, name, input };
					}
				}
				if (chunk.usage && !usageEmitted) {
					usageEmitted = true;
					yield {
						type: 'usage',
						usage: {
							inputTokens: chunk.usage.prompt_tokens ?? 0,
							outputTokens: chunk.usage.completion_tokens ?? 0,
							totalTokens:
								chunk.usage.total_tokens ??
								(chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0),
						},
					};
				}
			}
		}
		// Stream ended without explicit [DONE]. Emit any pending tool calls and a done event.
		yield* finalizeToolCalls(partialToolCalls);
		yield { type: 'done', ...(stopReason ? { finishReason: stopReason } : {}) };
	} finally {
		if (signal) signal.removeEventListener('abort', onAbort);
		try {
			reader.releaseLock();
		} catch {
			// ignore
		}
	}
}

function extractData(rawEvent: string): string | null {
	// SSE event may have multiple lines (event:, id:, data:, etc). Concatenate
	// `data:` lines per spec.
	const lines = rawEvent.split('\n');
	const dataLines: string[] = [];
	for (const line of lines) {
		if (line.startsWith('data:')) {
			dataLines.push(line.slice(5).replace(/^ /, ''));
		}
	}
	if (dataLines.length === 0) return null;
	return dataLines.join('\n');
}

function* finalizeToolCalls(
	partial: Map<number, { id: string; name: string; args: string }>,
): IterableIterator<StreamEvent> {
	for (const tc of partial.values()) {
		if (!tc.id || !tc.name) continue;
		let input: unknown = {};
		try {
			input = JSON.parse(tc.args || '{}');
		} catch {
			input = { _raw: tc.args };
		}
		yield { type: 'tool_call', id: tc.id, name: tc.name, input };
	}
	partial.clear();
}

function toCfMessages(systemPrompt: string | undefined, messages: Message[]): CfChatMessage[] {
	const out: CfChatMessage[] = [];
	if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
	for (const m of messages) {
		const blocks: ContentBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;

		if (m.role === 'system') {
			out.push({ role: 'system', content: flattenToText(blocks) });
			continue;
		}
		if (m.role === 'user') {
			out.push({ role: 'user', content: flattenToText(blocks) });
			continue;
		}
		if (m.role === 'tool') {
			const result = blocks.find((b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result');
			if (!result) continue;
			out.push({ role: 'tool', tool_call_id: result.toolUseId, content: result.content });
			continue;
		}
		// assistant
		const text = flattenToText(blocks);
		const toolCalls = blocks
			.filter((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')
			.map((b) => ({
				id: b.id,
				type: 'function' as const,
				function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
			}));
		const msg: CfChatMessage = {
			role: 'assistant',
			content: text || null,
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		};
		out.push(msg);
	}
	return out;
}

function flattenToText(blocks: ContentBlock[]): string {
	return blocks
		.map((b) => {
			if (b.type === 'text') return b.text;
			return '';
		})
		.join('');
}

function toCfTools(tools: ToolDefinition[]): CfTool[] {
	return tools.map((t) => ({
		type: 'function',
		function: { name: t.name, description: t.description, parameters: t.inputSchema },
	}));
}
