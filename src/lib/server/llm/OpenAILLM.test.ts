import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { OpenAILLM } from './OpenAILLM';
import type { StreamEvent } from './LLM';

function fakeClient(chunks: ChatCompletionChunk[], capture?: { params?: unknown }): OpenAI {
	return {
		chat: {
			completions: {
				create: async (params: unknown) => {
					if (capture) capture.params = params;
					return (async function* () {
						for (const c of chunks) yield c;
					})();
				},
			},
		},
	} as unknown as OpenAI;
}

function chunk(
	delta: Partial<ChatCompletionChunk.Choice.Delta> & { reasoning_content?: string },
	opts: { finish_reason?: string; usage?: ChatCompletionChunk['usage']; id?: string } = {},
): ChatCompletionChunk {
	return {
		id: opts.id ?? 'gen-1',
		object: 'chat.completion.chunk',
		created: 0,
		model: 'test/model',
		choices: [
			{
				index: 0,
				delta: delta as ChatCompletionChunk.Choice.Delta,
				finish_reason: (opts.finish_reason as ChatCompletionChunk.Choice['finish_reason']) ?? null,
			},
		],
		...(opts.usage ? { usage: opts.usage } : {}),
	} as unknown as ChatCompletionChunk;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

describe('OpenAILLM', () => {
	it('exposes model and providerID', () => {
		const llm = new OpenAILLM(fakeClient([]), 'gpt-5.5', 'openai-via-aig');
		expect(llm.model).toBe('gpt-5.5');
		expect(llm.providerID).toBe('openai-via-aig');
	});

	it('emits text_delta events for content chunks', async () => {
		const c = fakeClient([
			chunk({ content: 'Hello' }),
			chunk({ content: ', world' }),
			chunk({ content: '!' }),
			chunk({}, { finish_reason: 'stop' }),
		]);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [{ role: 'user', content: 'hi' }] }));
		const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
		expect(deltas).toEqual(['Hello', ', world', '!']);
		const done = events.at(-1);
		expect(done?.type).toBe('done');
		expect((done as { finishReason?: string }).finishReason).toBe('stop');
	});

	it('emits thinking_delta for reasoning_content chunks', async () => {
		const c = fakeClient([chunk({ reasoning_content: 'planning...' }), chunk({ content: 'answer' }), chunk({}, { finish_reason: 'stop' })]);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toContainEqual({ type: 'thinking_delta', delta: 'planning...' });
	});

	it('finalizes streaming tool calls', async () => {
		const c = fakeClient([
			chunk({
				tool_calls: [
					{
						index: 0,
						id: 'call_1',
						type: 'function',
						function: { name: 'web_search', arguments: '{"q":"' },
					},
				],
			}),
			chunk({
				tool_calls: [{ index: 0, function: { arguments: 'cats"}' } } as never],
			}),
			chunk({}, { finish_reason: 'tool_calls' }),
		]);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events.find((e) => e.type === 'tool_call')).toEqual({
			type: 'tool_call',
			id: 'call_1',
			name: 'web_search',
			input: { q: 'cats' },
		});
	});

	it('emits a usage event from the final chunk usage field', async () => {
		const c = fakeClient([
			chunk({ content: 'hi' }),
			chunk(
				{},
				{
					finish_reason: 'stop',
					usage: {
						prompt_tokens: 10,
						completion_tokens: 5,
						total_tokens: 15,
						prompt_tokens_details: { cached_tokens: 8 },
						completion_tokens_details: { reasoning_tokens: 3 },
					} as ChatCompletionChunk['usage'],
				},
			),
		]);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toContainEqual({
			type: 'usage',
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				totalTokens: 15,
				cacheReadInputTokens: 8,
				thinkingTokens: 3,
			},
		});
	});

	it('emits an error event when create() throws', async () => {
		const c = {
			chat: {
				completions: {
					create: async () => {
						throw new Error('boom');
					},
				},
			},
		} as unknown as OpenAI;
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toEqual([{ type: 'error', message: 'boom' }]);
	});

	it('prepends systemPrompt to the OpenAI message list', async () => {
		const capture: { params?: { messages?: Array<{ role: string; content: unknown }> } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(
			llm.chat({
				systemPrompt: 'be nice',
				messages: [{ role: 'user', content: 'hi' }],
			}),
		);
		expect(capture.params!.messages![0]).toEqual({ role: 'system', content: 'be nice' });
		expect(capture.params!.messages![1]).toEqual({ role: 'user', content: 'hi' });
	});

	it('serializes assistant tool_use blocks into OpenAI tool_calls', async () => {
		const capture: { params?: { messages?: Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string; content?: unknown }> } } =
			{};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(
			llm.chat({
				messages: [
					{ role: 'user', content: 'search' },
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'cats' } }],
					},
					{
						role: 'tool',
						content: [{ type: 'tool_result', toolUseId: 't1', content: 'no cats' }],
					},
				],
			}),
		);
		const msgs = capture.params!.messages!;
		expect(msgs[1]).toMatchObject({
			role: 'assistant',
			tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search' } }],
		});
		expect(msgs[2]).toMatchObject({ role: 'tool', tool_call_id: 't1', content: 'no cats' });
	});

	it('passes tool definitions to chat.completions.create', async () => {
		const capture: { params?: { tools?: unknown[] } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(
			llm.chat({
				messages: [],
				tools: [{ name: 'web_search', description: 'search', inputSchema: { type: 'object' } }],
			}),
		);
		expect(capture.params!.tools).toEqual([
			{
				type: 'function',
				function: { name: 'web_search', description: 'search', parameters: { type: 'object' } },
			},
		]);
	});

	it('forwards reasoning effort to reasoning_effort param', async () => {
		const capture: { params?: { reasoning_effort?: string } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(llm.chat({ messages: [], reasoning: { type: 'effort', effort: 'high' } }));
		expect(capture.params!.reasoning_effort).toBe('high');
	});

	it('maps xhigh effort onto OpenAI high (top of the supported enum)', async () => {
		const capture: { params?: { reasoning_effort?: string } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(llm.chat({ messages: [], reasoning: { type: 'effort', effort: 'xhigh' } }));
		expect(capture.params!.reasoning_effort).toBe('high');
	});

	it('omits reasoning_effort when effort is none', async () => {
		const capture: { params?: { reasoning_effort?: string } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(llm.chat({ messages: [], reasoning: { type: 'effort', effort: 'none' } }));
		expect(capture.params!.reasoning_effort).toBeUndefined();
	});

	it('emits stub tool message + synthetic user with image_url for array tool_result content', async () => {
		// OpenAI tool messages are string-only per the chat-completions API,
		// so when a tool returns image content we forward the images via a
		// follow-up user message. Regression: keep that hand-off intact for
		// vision-capable models running on OpenAI-compatible providers.
		const capture: { params?: { messages?: Array<Record<string, unknown>> } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-4o', 'openai-via-aig');
		await collect(
			llm.chat({
				messages: [
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 't1', name: 'sandbox_load_image', input: {} }],
					},
					{
						role: 'tool',
						content: [
							{
								type: 'tool_result',
								toolUseId: 't1',
								content: [
									{ type: 'text', text: 'Loaded photo.png.' },
									{ type: 'image', mimeType: 'image/png', data: 'AAAA' },
								],
							},
						],
					},
				],
			}),
		);
		const msgs = capture.params!.messages!;
		// Tool message is a stub string referencing the follow-up.
		expect(msgs[1]).toMatchObject({ role: 'tool', tool_call_id: 't1' });
		expect(typeof msgs[1].content).toBe('string');
		expect(msgs[1].content as string).toMatch(/Loaded photo\.png/);
		// Synthetic user message carries the image as a data URL.
		expect(msgs[2]).toMatchObject({ role: 'user' });
		const userContent = msgs[2].content as Array<Record<string, unknown>>;
		expect(userContent).toContainEqual({ type: 'text', text: 'Loaded photo.png.' });
		expect(userContent).toContainEqual({
			type: 'image_url',
			image_url: { url: 'data:image/png;base64,AAAA' },
		});
	});

	it('passes string tool_result content through unchanged (no synthetic user)', async () => {
		const capture: { params?: { messages?: Array<Record<string, unknown>> } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-4o', 'openai-via-aig');
		await collect(
			llm.chat({
				messages: [
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 't1', name: 'web_search', input: {} }],
					},
					{
						role: 'tool',
						content: [{ type: 'tool_result', toolUseId: 't1', content: 'no cats' }],
					},
				],
			}),
		);
		const msgs = capture.params!.messages!;
		expect(msgs).toHaveLength(2);
		expect(msgs[1]).toMatchObject({ role: 'tool', content: 'no cats' });
	});

	it('throws on tool message with no tool_result block', async () => {
		const llm = new OpenAILLM(fakeClient([]), 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [{ role: 'tool', content: 'oops' }] }));
		expect(events[0].type).toBe('error');
		expect((events[0] as { message: string }).message).toMatch(/tool_result/);
	});

	it('falls back to {_raw: ...} when tool call arguments fail to parse', async () => {
		const c = fakeClient([
			chunk({
				tool_calls: [
					{
						index: 0,
						id: 'call_1',
						type: 'function',
						function: { name: 'web_search', arguments: '{not json' },
					},
				],
			}),
			chunk({}, { finish_reason: 'tool_calls' }),
		]);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [] }));
		const finalCall = events.find((e) => e.type === 'tool_call');
		expect((finalCall as { input: unknown }).input).toEqual({ _raw: '{not json' });
	});
});
