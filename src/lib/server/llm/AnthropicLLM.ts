import Anthropic from '@anthropic-ai/sdk';
import type { Messages } from '@anthropic-ai/sdk/resources/messages/messages';
import type LLM from './LLM';
import type { CacheControl, ChatRequest, ContentBlock, Message, StreamEvent, ToolDefinition } from './LLM';
import { formatError } from './errors';

// Anthropic adapter. Honors:
//   - thinking: ChatRequest.thinking → Anthropic `thinking` param.
//   - cacheControl: applied to the last system block + the tools list when set.
//   - tools: passed through; tool_use blocks stream back as tool_call_delta /
//     tool_call events.
// PRD §5.1 / §7.2 P1.1 / P1.8 — extended thinking, prompt caching.

const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicLLM implements LLM {
	#client: Anthropic;
	model: string;
	providerID: string;

	constructor(client: Anthropic, model: string, providerID: string = 'anthropic') {
		this.#client = client;
		this.model = model;
		this.providerID = providerID;
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const partialToolUses = new Map<number, { id: string; name: string; args: string }>();
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let stopReason: string | null = null;

		try {
			const params: Messages.MessageCreateParamsStreaming = {
				model: this.model,
				max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
				messages: toAnthropicMessages(request.messages),
				stream: true,
			};
			const system = toAnthropicSystem(request.systemPrompt, request.cacheControl);
			if (system) params.system = system;
			if (request.tools && request.tools.length > 0) {
				params.tools = toAnthropicTools(request.tools, request.cacheControl);
			}
			// `thinking` and `reasoning` both map to Anthropic's thinking param.
			// `thinking` is the legacy native-Anthropic shape and takes precedence
			// when both are set (callers should pick one); `reasoning.max_tokens`
			// is the unified shape used by the OpenRouter path.
			if (request.thinking && request.thinking.type === 'enabled') {
				params.thinking = { type: 'enabled', budget_tokens: request.thinking.budgetTokens };
			} else if (request.reasoning && request.reasoning.type === 'max_tokens') {
				params.thinking = { type: 'enabled', budget_tokens: request.reasoning.maxTokens };
			}
			if (request.temperature !== undefined) params.temperature = request.temperature;

			const stream = this.#client.messages.stream(params, request.signal ? { signal: request.signal } : undefined);

			for await (const ev of stream) {
				if (ev.type === 'message_start') {
					const u = ev.message.usage;
					inputTokens = u.input_tokens ?? 0;
					outputTokens = u.output_tokens ?? 0;
					cacheRead = u.cache_read_input_tokens ?? 0;
					cacheWrite = u.cache_creation_input_tokens ?? 0;
				} else if (ev.type === 'content_block_start') {
					if (ev.content_block.type === 'tool_use') {
						partialToolUses.set(ev.index, {
							id: ev.content_block.id,
							name: ev.content_block.name,
							args: '',
						});
						yield { type: 'tool_call_delta', id: ev.content_block.id, name: ev.content_block.name };
					}
				} else if (ev.type === 'content_block_delta') {
					const d = ev.delta;
					if (d.type === 'text_delta') {
						yield { type: 'text_delta', delta: d.text };
					} else if (d.type === 'thinking_delta') {
						yield { type: 'thinking_delta', delta: d.thinking };
					} else if (d.type === 'input_json_delta') {
						const partial = partialToolUses.get(ev.index);
						if (partial) {
							partial.args += d.partial_json;
							yield {
								type: 'tool_call_delta',
								id: partial.id,
								argumentsDelta: d.partial_json,
							};
						}
					}
				} else if (ev.type === 'content_block_stop') {
					const partial = partialToolUses.get(ev.index);
					if (partial) {
						let input: unknown = {};
						try {
							input = partial.args ? JSON.parse(partial.args) : {};
						} catch {
							input = { _raw: partial.args };
						}
						yield { type: 'tool_call', id: partial.id, name: partial.name, input };
						partialToolUses.delete(ev.index);
					}
				} else if (ev.type === 'message_delta') {
					if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
					if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens;
				}
			}

			yield {
				type: 'usage',
				usage: {
					inputTokens,
					outputTokens,
					totalTokens: inputTokens + outputTokens,
					...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead } : {}),
					...(cacheWrite > 0 ? { cacheCreationInputTokens: cacheWrite } : {}),
				},
			};
			yield { type: 'done', ...(stopReason ? { finishReason: stopReason } : {}) };
		} catch (e) {
			yield { type: 'error', message: formatError(e) };
		}
	}
}

function toAnthropicMessages(messages: Message[]): Messages.MessageParam[] {
	return messages
		.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
		.map((m) => {
			if (m.role === 'tool') {
				// Phase 3b will materialize tool messages from the tool execution loop.
				// Until then, surface as a user message carrying the tool_result block.
				const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
				return { role: 'user' as const, content: blocksToAnthropic(blocks) };
			}
			const content =
				typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
			return { role: m.role as 'user' | 'assistant', content: blocksToAnthropic(content) };
		});
}

function blocksToAnthropic(blocks: ContentBlock[]): Messages.ContentBlockParam[] {
	return blocks
		.map((b): Messages.ContentBlockParam | null => {
			if (b.type === 'text') return { type: 'text', text: b.text };
			if (b.type === 'image') {
				return {
					type: 'image',
					source: { type: 'base64', media_type: b.mimeType as 'image/jpeg', data: b.data },
				};
			}
			if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
			if (b.type === 'tool_result') {
				return {
					type: 'tool_result',
					tool_use_id: b.toolUseId,
					content: b.content,
					...(b.isError ? { is_error: true } : {}),
				};
			}
			if (b.type === 'thinking') {
				return { type: 'thinking', thinking: b.text, signature: b.signature ?? '' };
			}
			// `file` blocks: Anthropic supports document blocks (PDF) — Phase 4 P0.6
			// will wire those properly. Drop here for now.
			return null;
		})
		.filter((x): x is Messages.ContentBlockParam => x !== null);
}

function toAnthropicSystem(
	systemPrompt: string | undefined,
	cacheControl: CacheControl | undefined,
): Messages.MessageCreateParams['system'] {
	if (!systemPrompt) return undefined;
	if (cacheControl?.type === 'ephemeral') {
		return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
	}
	return systemPrompt;
}

function toAnthropicTools(tools: ToolDefinition[], cacheControl: CacheControl | undefined): Messages.ToolUnion[] {
	return tools.map((t, i): Messages.ToolUnion => {
		const isLast = i === tools.length - 1;
		const tool: Messages.Tool = {
			name: t.name,
			description: t.description,
			input_schema: t.inputSchema as Messages.Tool.InputSchema,
		};
		if (isLast && cacheControl?.type === 'ephemeral') {
			tool.cache_control = { type: 'ephemeral' };
		}
		return tool;
	});
}

