import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type LLM from './LLM';
import type { ChatRequest, ContentBlock, Message, ReasoningEffort, StreamEvent, ToolDefinition } from './LLM';
import { formatError } from './errors';

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
				baseURL: config.baseURL,
				apiKey: config.apiKey,
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
				model: this.model,
				messages,
				stream: true,
				stream_options: { include_usage: true },
				...(tools ? { tools } : {}),
				...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
				...(request.maxTokens !== undefined ? { max_completion_tokens: request.maxTokens } : {}),
				...(request.reasoning?.type === 'effort' && request.reasoning.effort !== 'none' && request.reasoning.effort !== 'xhigh'
					? { reasoning_effort: mapReasoningEffort(request.reasoning.effort) }
					: {}),
				// Pass through custom reasoning param (e.g. OpenRouter)
				...(request.reasoning && request.reasoning.type !== 'effort' ? { reasoning: request.reasoning } : {}),
				...this.#extraBody,
			};

			const stream = await this.#client.chat.completions.create((body as unknown) as Parameters<OpenAI['chat']['completions']['create']>[0], request.signal ? { signal: request.signal } : undefined);

			for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
				lastChunk = chunk;
				const choice = chunk.choices[0];

				if (choice) {
					const delta = choice.delta as ChatCompletionChunk.Choice.Delta & {
						reasoning_content?: string | null;
						reasoning?: string | null;
					};
					if (delta?.content) yield { type: 'text_delta', delta: delta.content };
					const reasoningText = delta?.reasoning_content ?? delta?.reasoning ?? null;
					if (reasoningText) yield { type: 'thinking_delta', delta: reasoningText };

					if (delta?.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							const existing = partialToolCalls.get(idx) ?? { id: '', name: '', args: '', thoughtSignature: '' };
							if (tc.id) existing.id = tc.id;
							if (tc.function?.name) existing.name = tc.function.name;
							if (tc.function?.arguments) existing.args += tc.function.arguments;
							// Some gateways (e.g. Cloudflare AI Gateway for Gemini) include a
							// `thought_signature` field that must be preserved for tool calling
							// to work correctly on subsequent turns.
							const extra = tc as unknown as Record<string, unknown>;
							if (typeof extra.thought_signature === 'string') {
								existing.thoughtSignature = extra.thought_signature;
							}
							const fnExtra = tc.function as unknown as Record<string, unknown> | undefined;
							if (typeof fnExtra?.thought_signature === 'string') {
								existing.thoughtSignature = fnExtra.thought_signature;
							}
							partialToolCalls.set(idx, existing);
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

				if (chunk.usage) {
					const u = chunk.usage as ChatCompletionChunk['usage'] & {
						prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
						completion_tokens_details?: { reasoning_tokens?: number } | null;
					};
					yield {
						type: 'usage',
						usage: {
							inputTokens: u.prompt_tokens ?? 0,
							outputTokens: u.completion_tokens ?? 0,
							totalTokens:
								u.total_tokens ??
								(u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
							...(u.prompt_tokens_details?.cached_tokens != null
								? { cacheReadInputTokens: u.prompt_tokens_details.cached_tokens }
								: {}),
							...(u.prompt_tokens_details?.cache_write_tokens != null
								? { cacheCreationInputTokens: u.prompt_tokens_details.cache_write_tokens }
								: {}),
							...(u.completion_tokens_details?.reasoning_tokens != null
								? { thinkingTokens: u.completion_tokens_details.reasoning_tokens }
								: {}),
						},
					};
				}
			}

			yield* finalizeToolCalls(partialToolCalls);
			emittedDone = true;
			yield { type: 'done', ...(stopReason ? { finishReason: stopReason } : {}), raw: lastChunk };
		} catch (e) {
			if (!emittedDone) {
				yield { type: 'error', message: formatError(e) };
			}
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
			type: 'tool_call',
			id: tc.id,
			name: tc.name,
			input,
			...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
		};
	}
}

function mapReasoningEffort(effort: ReasoningEffort): 'minimal' | 'low' | 'medium' | 'high' {
	switch (effort) {
		case 'minimal':
			return 'minimal';
		case 'low':
			return 'low';
		case 'medium':
			return 'medium';
		case 'high':
			return 'high';
		default:
			return 'medium';
	}
}

function toOpenAIMessages(systemPrompt: string | undefined, messages: Message[]): ChatCompletionMessageParam[] {
	const out: ChatCompletionMessageParam[] = [];
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
			if (!result) {
				throw new Error('tool role message has no tool_result block');
			}
			out.push({ role: 'tool', tool_call_id: result.toolUseId, content: result.content });
			continue;
		}
		// assistant
		const text = flattenToText(blocks);
		const toolCalls = blocks
			.filter((b): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use')
			.map((b) => {
				const call: Record<string, unknown> = {
					id: b.id,
					type: 'function',
					function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
				};
				if (b.thoughtSignature) {
					call.thought_signature = b.thoughtSignature;
				}
				return call;
			});
		out.push({
			role: 'assistant',
			content: text || null,
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

function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
	return tools.map(
		(t): ChatCompletionTool => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description,
				parameters: t.inputSchema as Record<string, unknown>,
			},
		}),
	);
}
