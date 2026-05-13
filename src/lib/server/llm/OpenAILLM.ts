import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { formatError } from './errors';
import type LLM from './LLM';
import type { ChatRequest, ContentBlock, Message, ReasoningEffort, StreamEvent, ToolDefinition } from './LLM';

// OpenAI-format adapter. Handles any provider that speaks the OpenAI chat-
// completions protocol, including direct OpenAI, OpenRouter, DeepSeek, and AI
// Gateway's Unified API (`/compat`).
//
// The adapter constructs its own `openai` SDK client from the provider config
// (baseURL, apiKey, extraHeaders) and reuses it across turns for connection
// pooling.

export type OpenAILLMConfig = {
	baseURL: string;
	apiKey: string;
	extraHeaders?: Record<string, string>;
	extraBody?: Record<string, unknown>;
};

export class OpenAILLM implements LLM {
	#client: OpenAI;
	model: string;
	providerID: string;
	#extraBody?: Record<string, unknown>;

	constructor(config: OpenAILLMConfig, model: string, providerID: string);
	constructor(client: OpenAI, model: string, providerID: string);
	constructor(configOrClient: OpenAILLMConfig | OpenAI, model: string, providerID: string) {
		if ('chat' in configOrClient) {
			this.#client = configOrClient;
		} else {
			const config = configOrClient;
			this.#client = new OpenAI({
				apiKey: config.apiKey,
				baseURL: config.baseURL,
				dangerouslyAllowBrowser: true,
				...(config.extraHeaders ? { defaultHeaders: config.extraHeaders } : {}),
			});
			this.#extraBody = config.extraBody;
		}
		this.model = model;
		this.providerID = providerID;
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const partialToolCalls = new Map<number, { id: string; name: string; args: string; thoughtSignature: string }>();
		let emittedDone = false;
		let stopReason: string | null = null;
		let lastChunk: ChatCompletionChunk | null = null;

		try {
			const messages = toOpenAIMessages(request.systemPrompt, request.messages);
			const tools = request.tools && request.tools.length > 0 ? toOpenAITools(request.tools) : undefined;
			const body: Record<string, unknown> = {
				messages,
				model: this.model,
				stream: true,
				stream_options: { include_usage: true },
				...(tools ? { tools } : {}),
				...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
				...(request.maxTokens !== undefined ? { max_completion_tokens: request.maxTokens } : {}),
				...(request.reasoning?.type === 'effort' ? { reasoning_effort: mapReasoningEffort(request.reasoning.effort) } : {}),
				// Pass through custom reasoning param (e.g. OpenRouter)
				...(request.reasoning && request.reasoning.type !== 'effort' ? { reasoning: request.reasoning } : {}),
				...this.#extraBody,
			};

			const stream = await this.#client.chat.completions.create(
				body as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
				request.signal ? { signal: request.signal } : undefined,
			);

			for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
				lastChunk = chunk;
				const choice = chunk.choices[0];

				if (choice) {
					const delta = choice.delta as ChatCompletionChunk.Choice.Delta & {
						reasoning_content?: string | null;
						reasoning?: string | null;
					};
					if (delta?.content) yield { delta: delta.content, type: 'text_delta' };
					const reasoningText = delta?.reasoning_content ?? delta?.reasoning ?? null;
					if (reasoningText) yield { delta: reasoningText, type: 'thinking_delta' };

					if (delta?.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							const existing = partialToolCalls.get(idx) ?? { args: '', id: '', name: '', thoughtSignature: '' };
							if (tc.id) existing.id = tc.id;
							if (tc.function?.name) existing.name = tc.function.name;
							if (tc.function?.arguments) existing.args += tc.function.arguments;
							// Gemini (via its OpenAI-compat endpoint or AI Gateway) attaches
							// a thought signature to tool calls under
							// `extra_content.google.thought_signature`. The signature must
							// be echoed back on the assistant tool_call in subsequent turns
							// or the API rejects with a 400 "Function call is missing a
							// thought_signature" error. See
							// https://ai.google.dev/gemini-api/docs/thought-signatures
							const sig = extractThoughtSignature(tc as unknown as Record<string, unknown>);
							if (sig) existing.thoughtSignature = sig;
							partialToolCalls.set(idx, existing);
							yield {
								id: existing.id,
								type: 'tool_call_delta',
								...(tc.function?.name ? { name: tc.function.name } : {}),
								...(tc.function?.arguments ? { argumentsDelta: tc.function.arguments } : {}),
							};
						}
					}

					if (choice.finish_reason) stopReason = choice.finish_reason;
				}

				if (chunk.usage) {
					const u = chunk.usage as ChatCompletionChunk['usage'] & {
						prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
						completion_tokens_details?: { reasoning_tokens?: number } | null;
						// OpenRouter (and some other gateways) report total USD cost for
						// the request under `usage.cost` when the client opts into it
						// via the `usage.include` extra body param. We pass it through
						// untouched so the meta panel can show real spend.
						cost?: number | null;
					};
					yield {
						type: 'usage',
						usage: {
							inputTokens: u.prompt_tokens ?? 0,
							outputTokens: u.completion_tokens ?? 0,
							totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
							...(u.prompt_tokens_details?.cached_tokens != null ? { cacheReadInputTokens: u.prompt_tokens_details.cached_tokens } : {}),
							...(u.prompt_tokens_details?.cache_write_tokens != null
								? { cacheCreationInputTokens: u.prompt_tokens_details.cache_write_tokens }
								: {}),
							...(u.completion_tokens_details?.reasoning_tokens != null ? { thinkingTokens: u.completion_tokens_details.reasoning_tokens } : {}),
							...(typeof u.cost === 'number' && Number.isFinite(u.cost) ? { cost: u.cost } : {}),
						},
					};
				}
			}

			yield* finalizeToolCalls(partialToolCalls);
			emittedDone = true;
			yield { type: 'done', ...(stopReason ? { finishReason: stopReason } : {}), raw: lastChunk };
		} catch (e) {
			if (!emittedDone) {
				yield { message: formatError(e), type: 'error' };
				return;
			}
			// Throw-after-done indicates a bug elsewhere — surface so it isn't silent.
			console.warn('OpenAILLM: error after done', formatError(e));
		}
	}
}

function* finalizeToolCalls(
	partial: Map<number, { id: string; name: string; args: string; thoughtSignature: string }>,
): IterableIterator<StreamEvent> {
	for (const tc of partial.values()) {
		if (!tc.id || !tc.name) continue;
		let input: unknown;
		try {
			input = JSON.parse(tc.args);
		} catch {
			input = { _raw: tc.args };
		}
		yield {
			id: tc.id,
			input,
			name: tc.name,
			type: 'tool_call',
			...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
		};
	}
}

function mapReasoningEffort(effort: ReasoningEffort): 'none' | 'minimal' | 'low' | 'medium' | 'high' {
	switch (effort) {
		case 'none':
			return 'none';
		case 'minimal':
			return 'minimal';
		case 'low':
			return 'low';
		case 'medium':
			return 'medium';
		case 'high':
			return 'high';
		// OpenAI's reasoning_effort enum tops out at 'high'; map our 'xhigh'
		// to it so users who pick "extra high" still get the strongest valid
		// signal instead of the param being silently dropped.
		case 'xhigh':
			return 'high';
		default:
			return 'medium';
	}
}

function toOpenAIMessages(systemPrompt: string | undefined, messages: Message[]): ChatCompletionMessageParam[] {
	const out: ChatCompletionMessageParam[] = [];
	if (systemPrompt) out.push({ content: systemPrompt, role: 'system' });
	for (const m of messages) {
		const blocks: ContentBlock[] = typeof m.content === 'string' ? [{ text: m.content, type: 'text' }] : m.content;

		if (m.role === 'system') {
			out.push({ content: flattenToText(blocks), role: 'system' });
			continue;
		}
		if (m.role === 'user') {
			out.push({ content: flattenToText(blocks), role: 'user' });
			continue;
		}
		if (m.role === 'tool') {
			const result = blocks.find((b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result');
			if (!result) {
				throw new Error('tool role message has no tool_result block');
			}
			// OpenAI's `tool` role only accepts string content. When a tool
			// returns array content with images (e.g. sandbox_load_image), emit
			// a stub string in the tool message and a follow-up synthetic user
			// message carrying the images. The next assistant turn sees both
			// in history; OpenAI permits user messages between tool_result and
			// the next assistant turn.
			if (typeof result.content === 'string') {
				out.push({ content: result.content, role: 'tool', tool_call_id: result.toolUseId });
				continue;
			}
			const textPieces = result.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text);
			const imagePieces = result.content.filter((b): b is { type: 'image'; mimeType: string; data: string } => b.type === 'image');
			const stubText = textPieces.length > 0 ? textPieces.join('\n') : '[image returned — see following user message]';
			out.push({ content: stubText, role: 'tool', tool_call_id: result.toolUseId });
			if (imagePieces.length > 0) {
				const userContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
				if (textPieces.length > 0) userContent.push({ text: textPieces.join('\n'), type: 'text' });
				for (const img of imagePieces) {
					userContent.push({
						image_url: { url: `data:${img.mimeType};base64,${img.data}` },
						type: 'image_url',
					});
				}
				out.push({ content: userContent, role: 'user' } as ChatCompletionMessageParam);
			}
			continue;
		}
		// assistant
		const text = flattenToText(blocks);
		const toolCalls = blocks
			.filter((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')
			.map((b) => {
				const call: Record<string, unknown> = {
					function: { arguments: JSON.stringify(b.input ?? {}), name: b.name },
					id: b.id,
					type: 'function',
				};
				// Gemini's OpenAI-compat surface requires the thought signature to
				// round-trip on the assistant tool_call under
				// `extra_content.google.thought_signature` — see
				// https://ai.google.dev/gemini-api/docs/thought-signatures.
				// Other providers ignore unknown fields.
				if (b.thoughtSignature) {
					call.extra_content = { google: { thought_signature: b.thoughtSignature } };
				}
				return call;
			});
		out.push({
			content: text || null,
			role: 'assistant',
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		} as ChatCompletionMessageParam);
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

// Pull a Gemini thought signature out of a streaming tool_call delta or a
// non-streaming message tool_call. The signature lives at
// `extra_content.google.thought_signature` per Google's OpenAI-compat schema.
// We accept a few looser shapes too in case a gateway lifts the field.
function extractThoughtSignature(obj: Record<string, unknown> | undefined | null): string | null {
	if (!obj) return null;
	const extra = obj.extra_content as Record<string, unknown> | undefined;
	const google = extra?.google as Record<string, unknown> | undefined;
	const sig = google?.thought_signature;
	if (typeof sig === 'string' && sig.length > 0) return sig;
	// Fallback: some intermediaries place it directly on the tool_call or
	// inside the function object. Keep these as defensive last-resorts.
	const direct = obj.thought_signature;
	if (typeof direct === 'string' && direct.length > 0) return direct;
	const fn = obj.function as Record<string, unknown> | undefined;
	const fnSig = fn?.thought_signature;
	if (typeof fnSig === 'string' && fnSig.length > 0) return fnSig;
	return null;
}

function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
	return tools.map(
		(t): ChatCompletionTool => ({
			function: {
				description: t.description,
				name: t.name,
				parameters: t.inputSchema as Record<string, unknown>,
			},
			type: 'function',
		}),
	);
}
