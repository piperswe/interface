import { describe, expect, it } from 'vitest';
import type { OpenRouter } from '@openrouter/sdk';
import type { ChatStreamChunk } from '@openrouter/sdk/models';
import { OpenRouterLLM } from './OpenRouterLLM';
import type { StreamEvent } from './LLM';

function fakeClient(chunks: ChatStreamChunk[] | (() => AsyncIterable<ChatStreamChunk>)): OpenRouter {
	return {
		chat: {
			send: async () => {
				if (typeof chunks === 'function') return chunks();
				return (async function* () {
					for (const c of chunks) yield c;
				})();
			},
		},
	} as unknown as OpenRouter;
}

function chunk(partial: Partial<ChatStreamChunk['choices'][number]['delta']>, opts: { finishReason?: string; usage?: ChatStreamChunk['usage']; id?: string } = {}): ChatStreamChunk {
	return {
		id: opts.id ?? 'gen-1',
		object: 'chat.completion.chunk',
		created: 0,
		model: 'test/model',
		choices: [
			{
				index: 0,
				delta: partial as ChatStreamChunk['choices'][number]['delta'],
				finishReason: (opts.finishReason as ChatStreamChunk['choices'][number]['finishReason']) ?? null,
			},
		],
		...(opts.usage ? { usage: opts.usage } : {}),
	} as ChatStreamChunk;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

describe('OpenRouterLLM', () => {
	it('exposes model and providerID', () => {
		const llm = new OpenRouterLLM(fakeClient([]), 'anthropic/claude-sonnet', 'openrouter');
		expect(llm.model).toBe('anthropic/claude-sonnet');
		expect(llm.providerID).toBe('openrouter');
	});

	it('emits text_delta events for content chunks', async () => {
		const client = fakeClient([
			chunk({ content: 'Hello' }),
			chunk({ content: ', ' }),
			chunk({ content: 'world!' }),
			chunk({}, { finishReason: 'stop' }),
		]);
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [{ role: 'user', content: 'hi' }] }));

		const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
		expect(deltas).toEqual(['Hello', ', ', 'world!']);
		expect(events.at(-1)?.type).toBe('done');
	});

	it('emits thinking_delta for reasoning chunks', async () => {
		const client = fakeClient([
			chunk({ reasoning: 'Let me think' }),
			chunk({ content: 'Answer.' }),
			chunk({}, { finishReason: 'stop' }),
		]);
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [] }));
		const thinking = events.find((e) => e.type === 'thinking_delta');
		expect(thinking).toEqual({ type: 'thinking_delta', delta: 'Let me think' });
	});

	it('finalizes tool calls on finish_reason', async () => {
		const client = fakeClient([
			chunk({
				toolCalls: [
					{
						index: 0,
						id: 'call_1',
						type: 'function',
						function: { name: 'web_search', arguments: '{"q":"' },
					},
				],
			}),
			chunk({
				toolCalls: [
					{
						index: 0,
						function: { arguments: 'cats"}' },
					},
				],
			}),
			chunk({}, { finishReason: 'tool_calls' }),
		]);
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [] }));

		const finalCall = events.find((e) => e.type === 'tool_call');
		expect(finalCall).toEqual({ type: 'tool_call', id: 'call_1', name: 'web_search', input: { q: 'cats' } });
		const deltaCalls = events.filter((e) => e.type === 'tool_call_delta');
		expect(deltaCalls.length).toBe(2);
	});

	it('translates usage with cache and reasoning details', async () => {
		const client = fakeClient([
			chunk({ content: 'hi' }),
			chunk(
				{},
				{
					finishReason: 'stop',
					usage: {
						promptTokens: 100,
						completionTokens: 50,
						totalTokens: 150,
						promptTokensDetails: { cachedTokens: 80, cacheWriteTokens: 20 },
						completionTokensDetails: { reasoningTokens: 30 },
					},
				},
			),
		]);
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [] }));
		const usage = events.find((e) => e.type === 'usage');
		expect(usage).toEqual({
			type: 'usage',
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				cacheReadInputTokens: 80,
				cacheCreationInputTokens: 20,
				thinkingTokens: 30,
			},
		});
	});

	it('emits error event on send failure', async () => {
		const client = {
			chat: {
				send: async () => {
					throw new Error('boom');
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ type: 'error', message: 'boom' });
	});

	it('prepends systemPrompt to messages', async () => {
		let observedRequest: { messages: Array<{ role: string; content: string }> } | null = null;
		const client = {
			chat: {
				send: async (req: { chatRequest: { messages: Array<{ role: string; content: string }> } }) => {
					observedRequest = req.chatRequest;
					return (async function* () {
						yield chunk({ content: 'ok' });
						yield chunk({}, { finishReason: 'stop' });
					})();
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		await collect(
			llm.chat({
				systemPrompt: 'you are helpful',
				messages: [{ role: 'user', content: 'hi' }],
			}),
		);
		expect(observedRequest).not.toBeNull();
		expect(observedRequest!.messages[0]).toEqual({ role: 'system', content: 'you are helpful' });
		expect(observedRequest!.messages[1]).toEqual({ role: 'user', content: 'hi' });
	});

	it('emits an error if a tool message has no tool_result block', async () => {
		const client = fakeClient([]);
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [{ role: 'tool', content: 'result' }] }));
		const err = events.find((e) => e.type === 'error');
		expect(err?.type).toBe('error');
		expect((err as { message: string }).message).toMatch(/tool_result/);
	});

	it('serializes tool_use and tool_result blocks for the OpenRouter wire format', async () => {
		let observed: { messages: Array<{ role: string; toolCalls?: unknown[]; toolCallId?: string; content?: unknown }> } | null = null;
		const client = {
			chat: {
				send: async (req: { chatRequest: typeof observed }) => {
					observed = req.chatRequest;
					return (async function* () {
						yield chunk({}, { finishReason: 'stop' });
					})();
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		await collect(
			llm.chat({
				messages: [
					{ role: 'user', content: 'search for cats' },
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'cats' } }],
					},
					{
						role: 'tool',
						content: [{ type: 'tool_result', toolUseId: 't1', content: 'no cats found' }],
					},
				],
			}),
		);
		expect(observed!.messages[1]).toMatchObject({
			role: 'assistant',
			toolCalls: [{ id: 't1', type: 'function', function: { name: 'web_search' } }],
		});
		expect(observed!.messages[2]).toMatchObject({
			role: 'tool',
			toolCallId: 't1',
			content: 'no cats found',
		});
	});

	it('passes tool definitions to the SDK', async () => {
		let observed: { tools?: unknown[] } | null = null;
		const client = {
			chat: {
				send: async (req: { chatRequest: typeof observed }) => {
					observed = req.chatRequest;
					return (async function* () {
						yield chunk({}, { finishReason: 'stop' });
					})();
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		await collect(
			llm.chat({
				messages: [{ role: 'user', content: 'hi' }],
				tools: [
					{ name: 'web_search', description: 'search', inputSchema: { type: 'object' } },
				],
			}),
		);
		expect(observed!.tools).toEqual([
			{
				type: 'function',
				function: { name: 'web_search', description: 'search', parameters: { type: 'object' } },
			},
		]);
	});

	it('flattens ContentBlock arrays to text content', async () => {
		let observedRequest: { messages: Array<{ role: string; content: string }> } | null = null;
		const client = {
			chat: {
				send: async (req: { chatRequest: { messages: Array<{ role: string; content: string }> } }) => {
					observedRequest = req.chatRequest;
					return (async function* () {
						yield chunk({}, { finishReason: 'stop' });
					})();
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		await collect(
			llm.chat({
				messages: [
					{
						role: 'user',
						content: [
							{ type: 'text', text: 'a' },
							{ type: 'text', text: 'b' },
						],
					},
				],
			}),
		);
		expect(observedRequest!.messages[0].content).toBe('ab');
	});

	it('passes temperature and maxTokens to the SDK request', async () => {
		let observed: { temperature?: number; maxTokens?: number } | null = null;
		const client = {
			chat: {
				send: async (req: { chatRequest: typeof observed }) => {
					observed = req.chatRequest;
					return (async function* () {
						yield chunk({}, { finishReason: 'stop' });
					})();
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		await collect(llm.chat({ messages: [], temperature: 0.42, maxTokens: 256 }));
		expect(observed!.temperature).toBe(0.42);
		expect(observed!.maxTokens).toBe(256);
	});

	it('passes reasoning config to the SDK request', async () => {
		let observed: { reasoning?: unknown } | null = null;
		const client = {
			chat: {
				send: async (req: { chatRequest: typeof observed }) => {
					observed = req.chatRequest;
					return (async function* () {
						yield chunk({}, { finishReason: 'stop' });
					})();
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		await collect(
			llm.chat({
				messages: [],
				reasoning: { type: 'effort', effort: 'high' },
			}),
		);
		expect(observed!.reasoning).toEqual({ type: 'effort', effort: 'high' });
	});

	it('passes max_tokens reasoning config to the SDK request', async () => {
		let observed: { reasoning?: unknown } | null = null;
		const client = {
			chat: {
				send: async (req: { chatRequest: typeof observed }) => {
					observed = req.chatRequest;
					return (async function* () {
						yield chunk({}, { finishReason: 'stop' });
					})();
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		await collect(
			llm.chat({
				messages: [],
				reasoning: { type: 'max_tokens', maxTokens: 4096 },
			}),
		);
		expect(observed!.reasoning).toEqual({ type: 'max_tokens', maxTokens: 4096 });
	});

	it('emits a usage event when usage is sent without a choices payload', async () => {
		const client = fakeClient([
			{
				id: 'gen-1',
				object: 'chat.completion.chunk',
				created: 0,
				model: 'm',
				choices: [],
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			} as unknown as ChatStreamChunk,
		]);
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toContainEqual({
			type: 'usage',
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		});
	});

	it('falls back to {_raw: ...} when tool call arguments fail to parse as JSON', async () => {
		const client = fakeClient([
			chunk({
				toolCalls: [
					{
						index: 0,
						id: 'call_1',
						type: 'function',
						function: { name: 'web_search', arguments: '{not json' },
					},
				],
			}),
			chunk({}, { finishReason: 'tool_calls' }),
		]);
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [] }));
		const finalCall = events.find((e) => e.type === 'tool_call');
		expect((finalCall as { input: unknown }).input).toEqual({ _raw: '{not json' });
	});

	it('serializes non-Error throw values as strings', async () => {
		const client = {
			chat: {
				send: async () => {
					throw { code: 42 };
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		const events = await collect(llm.chat({ messages: [] }));
		expect((events[0] as { message: string }).message).toContain('42');
	});

	it('omits content from assistant messages with no text but a tool_use block', async () => {
		let observed: { messages: Array<{ content: unknown; toolCalls?: unknown[] }> } | null = null;
		const client = {
			chat: {
				send: async (req: { chatRequest: typeof observed }) => {
					observed = req.chatRequest;
					return (async function* () {
						yield chunk({}, { finishReason: 'stop' });
					})();
				},
			},
		} as unknown as OpenRouter;
		const llm = new OpenRouterLLM(client, 'm', 'openrouter');
		await collect(
			llm.chat({
				messages: [
					{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
				],
			}),
		);
		expect(observed!.messages[0].content).toBeNull();
		expect(observed!.messages[0].toolCalls).toBeDefined();
	});
});
