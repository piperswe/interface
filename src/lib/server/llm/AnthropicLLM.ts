import Anthropic from '@anthropic-ai/sdk';
import type { Messages } from '@anthropic-ai/sdk/resources/messages/messages';
import { formatError } from './errors';
import type LLM from './LLM';
import type { CacheControl, ChatRequest, ContentBlock, Message, StreamEvent, ToolDefinition } from './LLM';

// Anthropic adapter. Honors:
//   - thinking: ChatRequest.thinking → Anthropic `thinking` param.
//   - cacheControl: applied to the last system block + the tools list when set.
//   - tools: passed through; tool_use blocks stream back as tool_call_delta /
//     tool_call events.

const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicLLM implements LLM {
	#client: Anthropic;
	model: string;
	providerID: string;

	constructor(apiKey: string, model: string, providerID?: string);
	constructor(client: Anthropic, model: string, providerID?: string);
	constructor(apiKeyOrClient: string | Anthropic, model: string, providerID: string = 'anthropic') {
		if (typeof apiKeyOrClient === 'string') {
			this.#client = new Anthropic({ apiKey: apiKeyOrClient });
		} else {
			this.#client = apiKeyOrClient;
		}
		this.model = model;
		this.providerID = providerID;
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		const partialToolUses = new Map<number, { id: string; name: string; args: string }>();
		// Track open thinking-block indices so we can fish the SDK-supplied
		// signature out of `content_block_stop` and emit it as a
		// `thinking_signature` event for the caller to attach to the matching
		// `ThinkingPart`.
		const openThinking = new Set<number>();
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let stopReason: string | null = null;

		try {
			// Anthropic's API splits messages from the system instruction. Any
			// `role: 'system'` entries in our cross-provider message list (e.g.
			// the compaction summary, or a `Summarize...` instruction passed
			// inline) must be merged into the `system` param — otherwise the
			// filter in `toAnthropicMessages` would drop them silently.
			const inlineSystem = request.messages
				.filter((m) => m.role === 'system')
				.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')))
				.filter((s) => s.length > 0);
			const combinedSystemPrompt = [request.systemPrompt, ...inlineSystem].filter((s): s is string => !!s && s.length > 0).join('\n\n');
			const params: Messages.MessageCreateParamsStreaming = {
				max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
				messages: toAnthropicMessages(request.messages),
				model: this.model,
				stream: true,
			};
			const system = toAnthropicSystem(combinedSystemPrompt || undefined, request.cacheControl);
			if (system) params.system = system;
			if (request.tools && request.tools.length > 0) {
				params.tools = toAnthropicTools(request.tools, request.cacheControl);
			}
			// `thinking` and `reasoning` both map to Anthropic's thinking param.
			// `thinking` is the legacy native-Anthropic shape and takes precedence
			// when both are set (callers should pick one); `reasoning.max_tokens`
			// is the unified shape used by the OpenRouter path.
			if (request.thinking?.type === 'enabled') {
				params.thinking = { budget_tokens: request.thinking.budgetTokens, type: 'enabled' };
			} else if (request.thinking?.type === 'disabled') {
				params.thinking = { type: 'disabled' };
			} else if (request.reasoning?.type === 'max_tokens') {
				params.thinking = { budget_tokens: request.reasoning.maxTokens, type: 'enabled' };
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
							args: '',
							id: ev.content_block.id,
							name: ev.content_block.name,
						});
						yield { id: ev.content_block.id, name: ev.content_block.name, type: 'tool_call_delta' };
					} else if (ev.content_block.type === 'thinking') {
						openThinking.add(ev.index);
					}
				} else if (ev.type === 'content_block_delta') {
					const d = ev.delta;
					if (d.type === 'text_delta') {
						yield { delta: d.text, type: 'text_delta' };
					} else if (d.type === 'thinking_delta') {
						yield { delta: d.thinking, type: 'thinking_delta' };
					} else if (d.type === 'signature_delta') {
						// Anthropic delivers the thinking-block signature as a single
						// non-incremental delta. Forward it so the caller can attach
						// it to the matching `ThinkingPart` for round-trip on the
						// next turn.
						if (openThinking.has(ev.index) && d.signature) {
							yield { signature: d.signature, type: 'thinking_signature' };
						}
					} else if (d.type === 'input_json_delta') {
						const partial = partialToolUses.get(ev.index);
						if (partial) {
							partial.args += d.partial_json;
							yield {
								argumentsDelta: d.partial_json,
								id: partial.id,
								type: 'tool_call_delta',
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
						yield { id: partial.id, input, name: partial.name, type: 'tool_call' };
						partialToolUses.delete(ev.index);
					}
					openThinking.delete(ev.index);
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
			yield { message: formatError(e), type: 'error' };
		}
	}
}

function toAnthropicMessages(messages: Message[]): Messages.MessageParam[] {
	return messages
		.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
		.map((m) => {
			if (m.role === 'tool') {
				const blocks = typeof m.content === 'string' ? [{ text: m.content, type: 'text' as const }] : m.content;
				return { content: blocksToAnthropic(blocks), role: 'user' as const };
			}
			const content = typeof m.content === 'string' ? [{ text: m.content, type: 'text' as const }] : m.content;
			return { content: blocksToAnthropic(content), role: m.role as 'user' | 'assistant' };
		});
}

function blocksToAnthropic(blocks: ContentBlock[]): Messages.ContentBlockParam[] {
	return blocks
		.map((b): Messages.ContentBlockParam | null => {
			if (b.type === 'text') return { text: b.text, type: 'text' };
			if (b.type === 'image') {
				return {
					source: { data: b.data, media_type: b.mimeType as 'image/jpeg', type: 'base64' },
					type: 'image',
				};
			}
			if (b.type === 'tool_use') return { id: b.id, input: b.input, name: b.name, type: 'tool_use' };
			if (b.type === 'tool_result') {
				// `content` may be a plain string or an array of text/image
				// blocks (multimodal tool returns). Anthropic's tool_result
				// accepts both shapes natively; the array form maps 1:1.
				const content =
					typeof b.content === 'string'
						? b.content
						: b.content.map((blk) =>
								blk.type === 'image'
									? {
											source: {
												data: blk.data,
												media_type: blk.mimeType as 'image/jpeg',
												type: 'base64' as const,
											},
											type: 'image' as const,
										}
									: { text: blk.text, type: 'text' as const },
							);
				return {
					content,
					tool_use_id: b.toolUseId,
					type: 'tool_result',
					...(b.isError ? { is_error: true } : {}),
				};
			}
			if (b.type === 'thinking') {
				// Anthropic requires a non-empty signature on round-tripped thinking
				// blocks. Drop signature-less entries — `sanitizeHistoryForModel`
				// strips them before this adapter runs, so this is defense in depth
				// for legacy rows or test fixtures.
				if (!b.signature) return null;
				return { signature: b.signature, thinking: b.text, type: 'thinking' };
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
		return [{ cache_control: { type: 'ephemeral' }, text: systemPrompt, type: 'text' }];
	}
	return systemPrompt;
}

function toAnthropicTools(tools: ToolDefinition[], cacheControl: CacheControl | undefined): Messages.ToolUnion[] {
	return tools.map((t, i): Messages.ToolUnion => {
		const isLast = i === tools.length - 1;
		const tool: Messages.Tool = {
			description: t.description,
			input_schema: t.inputSchema as Messages.Tool.InputSchema,
			name: t.name,
		};
		if (isLast && cacheControl?.type === 'ephemeral') {
			tool.cache_control = { type: 'ephemeral' };
		}
		return tool;
	});
}
