import type OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type LLM from './LLM';
import type { ChatRequest, ContentBlock, Message, ReasoningEffort, StreamEvent, ToolDefinition } from './LLM';
import { formatError } from './errors';

// OpenAI-format adapter. Used for:
//   - Direct OpenAI traffic via AI Gateway (`getUrl('openai')`).
//   - DeepSeek traffic via AI Gateway (`getUrl('deepseek')`).
//   - The Unified API catch-all (`getUrl()` + `/compat`) — accepts any
//     `provider/model` slug supported by AI Gateway.
//
// The `client` is constructed in `route.ts` with the appropriate `baseURL`
// and `defaultHeaders` (notably `cf-aig-authorization` for unified billing).
// This adapter makes no assumptions about the destination — it just speaks
// OpenAI's chat-completions protocol.

export class OpenAILLM implements LLM {
	#client: OpenAI;
	model: string;
	providerID: string;

	constructor(client: OpenAI, model: string, providerID: string) {
		this.#client = client;
		this.model = model;
		this.providerID = providerID;
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const partialToolCalls = new Map<number, { id: string; name: string; args: string }>();
		let emittedDone = false;
		let stopReason: string | null = null;
		let lastChunk: ChatCompletionChunk | null = null;

		try {
			const messages = toOpenAIMessages(request.systemPrompt, request.messages);
			const tools = request.tools && request.tools.length > 0 ? toOpenAITools(request.tools) : undefined;
			const params: Parameters<OpenAI['chat']['completions']['create']>[0] = {
				model: this.model,
				messages,
				stream: true,
				stream_options: { include_usage: true },
			};
			if (tools) params.tools = tools;
			if (request.temperature !== undefined) params.temperature = request.temperature;
			if (request.maxTokens !== undefined) params.max_completion_tokens = request.maxTokens;
			if (request.reasoning?.type === 'effort' && request.reasoning.effort !== 'none' && request.reasoning.effort !== 'xhigh') {
				params.reasoning_effort = mapReasoningEffort(request.reasoning.effort);
			}

			const stream = await this.#client.chat.completions.create(
				params,
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
					if (delta?.content) yield { type: 'text_delta', delta: delta.content };
					const reasoningText = delta?.reasoning_content ?? delta?.reasoning ?? null;
					if (reasoningText) yield { type: 'thinking_delta', delta: reasoningText };

					if (delta?.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							const existing = partialToolCalls.get(idx) ?? { id: '', name: '', args: '' };
							if (tc.id) existing.id = tc.id;
							if (tc.function?.name) existing.name = tc.function.name;
							if (tc.function?.arguments) existing.args += tc.function.arguments;
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
					yield {
						type: 'usage',
						usage: {
							inputTokens: chunk.usage.prompt_tokens ?? 0,
							outputTokens: chunk.usage.completion_tokens ?? 0,
							totalTokens:
								chunk.usage.total_tokens ??
								(chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0),
							...(chunk.usage.prompt_tokens_details?.cached_tokens != null
								? { cacheReadInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }
								: {}),
							...(chunk.usage.completion_tokens_details?.reasoning_tokens != null
								? { thinkingTokens: chunk.usage.completion_tokens_details.reasoning_tokens }
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
			.map((b) => ({
				id: b.id,
				type: 'function' as const,
				function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
			}));
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
