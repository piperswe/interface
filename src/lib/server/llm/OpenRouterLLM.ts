import { OpenRouter } from '@openrouter/sdk';
import type { ChatFunctionTool, ChatMessages, ChatStreamChunk } from '@openrouter/sdk/models';
import type LLM from './LLM';
import type { ChatRequest, ContentBlock, Message, StreamEvent, ToolDefinition } from './LLM';

export class OpenRouterLLM implements LLM {
	#client: OpenRouter;
	model: string;
	providerID: string;

	constructor(client: OpenRouter, model: string, providerID: string) {
		this.#client = client;
		this.model = model;
		this.providerID = providerID;
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		let lastChunk: ChatStreamChunk | null = null;
		const partialToolCalls = new Map<number, { id: string; name: string; args: string }>();
		let emittedDone = false;

		try {
			const messages: ChatMessages[] = request.messages.map(toOpenRouterMessage);
			if (request.systemPrompt) {
				messages.unshift({ role: 'system', content: request.systemPrompt });
			}
			const tools = request.tools && request.tools.length > 0 ? toOpenRouterTools(request.tools) : undefined;
			const stream = await this.#client.chat.send({
				chatRequest: {
					messages,
					model: this.model,
					stream: true,
					...(tools ? { tools } : {}),
					...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
					...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
					...(request.reasoning ? { reasoning: request.reasoning as unknown as import('@openrouter/sdk/models').Reasoning } : {}),
				},
			});

			for await (const chunk of stream) {
				lastChunk = chunk;
				const choice = chunk?.choices?.[0];
				if (!choice) {
					if (chunk?.usage) yield* yieldUsage(chunk.usage);
					continue;
				}

				const delta = choice.delta;
				if (delta?.content) yield { type: 'text_delta', delta: delta.content };
				if (delta?.reasoning) yield { type: 'thinking_delta', delta: delta.reasoning };

				if (delta?.toolCalls) {
					for (const tc of delta.toolCalls) {
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

				if (chunk.usage) yield* yieldUsage(chunk.usage);

				if (choice.finishReason) {
					for (const tc of partialToolCalls.values()) {
						if (tc.id && tc.name) {
							let input: unknown = {};
							try {
								input = JSON.parse(tc.args || '{}');
							} catch {
								input = { _raw: tc.args };
							}
							yield { type: 'tool_call', id: tc.id, name: tc.name, input };
						}
					}
					partialToolCalls.clear();
					emittedDone = true;
					yield { type: 'done', finishReason: choice.finishReason, raw: lastChunk };
				}
			}

			// Some providers omit finishReason on the final chunk. Guarantee a
			// done event so the consumer can finalise correctly.
			if (!emittedDone) {
				for (const tc of partialToolCalls.values()) {
					if (tc.id && tc.name) {
						let input: unknown = {};
						try {
							input = JSON.parse(tc.args || '{}');
						} catch {
							input = { _raw: tc.args };
						}
						yield { type: 'tool_call', id: tc.id, name: tc.name, input };
					}
				}
				partialToolCalls.clear();
				yield { type: 'done', raw: lastChunk };
			}
		} catch (e) {
			yield { type: 'error', message: formatError(e) };
		}
	}
}

function* yieldUsage(usage: NonNullable<ChatStreamChunk['usage']>): IterableIterator<StreamEvent> {
	yield {
		type: 'usage',
		usage: {
			inputTokens: usage.promptTokens,
			outputTokens: usage.completionTokens,
			totalTokens: usage.totalTokens,
			...(usage.promptTokensDetails?.cachedTokens != null
				? { cacheReadInputTokens: usage.promptTokensDetails.cachedTokens }
				: {}),
			...(usage.promptTokensDetails?.cacheWriteTokens != null
				? { cacheCreationInputTokens: usage.promptTokensDetails.cacheWriteTokens }
				: {}),
			...(usage.completionTokensDetails?.reasoningTokens != null
				? { thinkingTokens: usage.completionTokensDetails.reasoningTokens }
				: {}),
		},
	};
}

function toOpenRouterMessage(m: Message): ChatMessages {
	const blocks: ContentBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;

	if (m.role === 'system') {
		return { role: 'system', content: flattenToText(blocks) };
	}

	if (m.role === 'user') {
		return { role: 'user', content: flattenToText(blocks) };
	}

	if (m.role === 'tool') {
		// One ToolResultContent → one ChatToolMessage. Multiple results are
		// emitted as separate messages by the caller.
		const result = blocks.find((b): b is ContentBlock & { type: 'tool_result' } => b.type === 'tool_result');
		if (!result) {
			throw new Error('tool role message has no tool_result block');
		}
		return {
			role: 'tool',
			toolCallId: result.toolUseId,
			content: result.content,
		};
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
	const assistantMessage: ChatMessages = {
		role: 'assistant',
		...(text ? { content: text } : { content: null }),
		...(toolCalls.length > 0 ? { toolCalls } : {}),
	};
	return assistantMessage;
}

function flattenToText(blocks: ContentBlock[]): string {
	return blocks
		.map((b) => {
			if (b.type === 'text') return b.text;
			return '';
		})
		.join('');
}

function toOpenRouterTools(tools: ToolDefinition[]): ChatFunctionTool[] {
	return tools.map(
		(t): ChatFunctionTool => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description,
				parameters: t.inputSchema as { [k: string]: unknown },
			},
		}),
	);
}

function formatError(e: unknown): string {
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
