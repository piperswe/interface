import type OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import { assertDefined } from '../../../../test/assert-defined';
import type { StreamEvent } from './LLM';
import { OpenAILLM } from './OpenAILLM';

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
		choices: [
			{
				delta: delta as ChatCompletionChunk.Choice.Delta,
				finish_reason: (opts.finish_reason as ChatCompletionChunk.Choice['finish_reason']) ?? null,
				index: 0,
			},
		],
		created: 0,
		id: opts.id ?? 'gen-1',
		model: 'test/model',
		object: 'chat.completion.chunk',
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
		const events = await collect(llm.chat({ messages: [{ content: 'hi', role: 'user' }] }));
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
		expect(events).toContainEqual({ delta: 'planning...', type: 'thinking_delta' });
	});

	it('finalizes streaming tool calls', async () => {
		const c = fakeClient([
			chunk({
				tool_calls: [
					{
						function: { arguments: '{"q":"', name: 'web_search' },
						id: 'call_1',
						index: 0,
						type: 'function',
					},
				],
			}),
			chunk({
				tool_calls: [{ function: { arguments: 'cats"}' }, index: 0 } as never],
			}),
			chunk({}, { finish_reason: 'tool_calls' }),
		]);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events.find((e) => e.type === 'tool_call')).toEqual({
			id: 'call_1',
			input: { q: 'cats' },
			name: 'web_search',
			type: 'tool_call',
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
						completion_tokens: 5,
						completion_tokens_details: { reasoning_tokens: 3 },
						prompt_tokens: 10,
						prompt_tokens_details: { cached_tokens: 8 },
						total_tokens: 15,
					} as ChatCompletionChunk['usage'],
				},
			),
		]);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toContainEqual({
			type: 'usage',
			usage: {
				cacheReadInputTokens: 8,
				inputTokens: 10,
				outputTokens: 5,
				thinkingTokens: 3,
				totalTokens: 15,
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
		expect(events).toEqual([{ message: 'boom', type: 'error' }]);
	});

	it('prepends systemPrompt to the OpenAI message list', async () => {
		const capture: { params?: { messages?: Array<{ role: string; content: unknown }> } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(
			llm.chat({
				messages: [{ content: 'hi', role: 'user' }],
				systemPrompt: 'be nice',
			}),
		);
		assertDefined(capture.params);
		assertDefined(capture.params.messages);
		expect(capture.params.messages[0]).toEqual({ content: 'be nice', role: 'system' });
		expect(capture.params.messages[1]).toEqual({ content: 'hi', role: 'user' });
	});

	it('serializes assistant tool_use blocks into OpenAI tool_calls', async () => {
		const capture: { params?: { messages?: Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string; content?: unknown }> } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(
			llm.chat({
				messages: [
					{ content: 'search', role: 'user' },
					{
						content: [{ id: 't1', input: { q: 'cats' }, name: 'web_search', type: 'tool_use' }],
						role: 'assistant',
					},
					{
						content: [{ content: 'no cats', toolUseId: 't1', type: 'tool_result' }],
						role: 'tool',
					},
				],
			}),
		);
		assertDefined(capture.params);
		assertDefined(capture.params.messages);
		const msgs = capture.params.messages;
		expect(msgs[1]).toMatchObject({
			role: 'assistant',
			tool_calls: [{ function: { name: 'web_search' }, id: 't1', type: 'function' }],
		});
		expect(msgs[2]).toMatchObject({ content: 'no cats', role: 'tool', tool_call_id: 't1' });
	});

	it('passes tool definitions to chat.completions.create', async () => {
		const capture: { params?: { tools?: unknown[] } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(
			llm.chat({
				messages: [],
				tools: [{ description: 'search', inputSchema: { type: 'object' }, name: 'web_search' }],
			}),
		);
		assertDefined(capture.params);
		expect(capture.params.tools).toEqual([
			{
				function: { description: 'search', name: 'web_search', parameters: { type: 'object' } },
				type: 'function',
			},
		]);
	});

	it('forwards reasoning effort to reasoning_effort param', async () => {
		const capture: { params?: { reasoning_effort?: string } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(llm.chat({ messages: [], reasoning: { effort: 'high', type: 'effort' } }));
		assertDefined(capture.params);
		expect(capture.params.reasoning_effort).toBe('high');
	});

	it('maps xhigh effort onto OpenAI high (top of the supported enum)', async () => {
		const capture: { params?: { reasoning_effort?: string } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(llm.chat({ messages: [], reasoning: { effort: 'xhigh', type: 'effort' } }));
		assertDefined(capture.params);
		expect(capture.params.reasoning_effort).toBe('high');
	});

	it('sends reasoning_effort:none when effort is none', async () => {
		// Regression: we used to omit reasoning_effort entirely for 'none', but
		// some models (e.g. Kimi K2.6 via Cloudflare AI Gateway) default to
		// reasoning ON when the param is absent. Sending 'none' explicitly
		// is the correct way to disable reasoning on these models.
		const capture: { params?: { reasoning_effort?: string } } = {};
		const c = fakeClient([chunk({}, { finish_reason: 'stop' })], capture);
		const llm = new OpenAILLM(c, 'gpt-5.5', 'openai-via-aig');
		await collect(llm.chat({ messages: [], reasoning: { effort: 'none', type: 'effort' } }));
		assertDefined(capture.params);
		expect(capture.params.reasoning_effort).toBe('none');
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
						content: [{ id: 't1', input: {}, name: 'sandbox_load_image', type: 'tool_use' }],
						role: 'assistant',
					},
					{
						content: [
							{
								content: [
									{ text: 'Loaded photo.png.', type: 'text' },
									{ data: 'AAAA', mimeType: 'image/png', type: 'image' },
								],
								toolUseId: 't1',
								type: 'tool_result',
							},
						],
						role: 'tool',
					},
				],
			}),
		);
		assertDefined(capture.params);
		assertDefined(capture.params.messages);
		const msgs = capture.params.messages;
		// Tool message is a stub string referencing the follow-up.
		expect(msgs[1]).toMatchObject({ role: 'tool', tool_call_id: 't1' });
		expect(typeof msgs[1].content).toBe('string');
		expect(msgs[1].content as string).toMatch(/Loaded photo\.png/);
		// Synthetic user message carries the image as a data URL.
		expect(msgs[2]).toMatchObject({ role: 'user' });
		const userContent = msgs[2].content as Array<Record<string, unknown>>;
		expect(userContent).toContainEqual({ text: 'Loaded photo.png.', type: 'text' });
		expect(userContent).toContainEqual({
			image_url: { url: 'data:image/png;base64,AAAA' },
			type: 'image_url',
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
						content: [{ id: 't1', input: {}, name: 'web_search', type: 'tool_use' }],
						role: 'assistant',
					},
					{
						content: [{ content: 'no cats', toolUseId: 't1', type: 'tool_result' }],
						role: 'tool',
					},
				],
			}),
		);
		assertDefined(capture.params);
		assertDefined(capture.params.messages);
		const msgs = capture.params.messages;
		expect(msgs).toHaveLength(2);
		expect(msgs[1]).toMatchObject({ content: 'no cats', role: 'tool' });
	});

	it('throws on tool message with no tool_result block', async () => {
		const llm = new OpenAILLM(fakeClient([]), 'gpt-5.5', 'openai-via-aig');
		const events = await collect(llm.chat({ messages: [{ content: 'oops', role: 'tool' }] }));
		expect(events[0].type).toBe('error');
		expect((events[0] as { message: string }).message).toMatch(/tool_result/);
	});

	it('falls back to {_raw: ...} when tool call arguments fail to parse', async () => {
		const c = fakeClient([
			chunk({
				tool_calls: [
					{
						function: { arguments: '{not json', name: 'web_search' },
						id: 'call_1',
						index: 0,
						type: 'function',
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
