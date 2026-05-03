import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import { AnthropicLLM } from './AnthropicLLM';
import type { StreamEvent } from './LLM';

function fakeAnthropic(events: MessageStreamEvent[], capture?: { params?: unknown }): Anthropic {
	return {
		messages: {
			stream(params: unknown) {
				if (capture) capture.params = params;
				return (async function* () {
					for (const e of events) yield e;
				})();
			},
		},
	} as unknown as Anthropic;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

function messageStartEvent(input = 100, output = 0): MessageStreamEvent {
	return {
		type: 'message_start',
		message: {
			id: 'msg_1',
			type: 'message',
			role: 'assistant',
			model: 'claude-sonnet-4-5',
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: input,
				output_tokens: output,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				server_tool_use: null,
				service_tier: null,
			},
		},
	} as unknown as MessageStreamEvent;
}

describe('AnthropicLLM', () => {
	it('exposes model and providerID', () => {
		const llm = new AnthropicLLM(fakeAnthropic([]), 'claude-sonnet-4-5');
		expect(llm.model).toBe('claude-sonnet-4-5');
		expect(llm.providerID).toBe('anthropic');
	});

	it('emits text_delta + usage + done for a basic text response', async () => {
		const llm = new AnthropicLLM(
			fakeAnthropic([
				messageStartEvent(),
				{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as unknown as MessageStreamEvent,
				{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } as unknown as MessageStreamEvent,
				{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } as unknown as MessageStreamEvent,
				{ type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent,
				{
					type: 'message_delta',
					delta: { stop_reason: 'end_turn', stop_sequence: null },
					usage: { output_tokens: 50 },
				} as unknown as MessageStreamEvent,
				{ type: 'message_stop' } as unknown as MessageStreamEvent,
			]),
			'claude-sonnet-4-5',
		);
		const events = await collect(llm.chat({ messages: [{ role: 'user', content: 'hi' }] }));
		const texts = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
		expect(texts).toEqual(['Hello', ' world']);
		const usage = events.find((e) => e.type === 'usage');
		expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'end_turn' });
	});

	it('emits thinking_delta for thinking blocks', async () => {
		const llm = new AnthropicLLM(
			fakeAnthropic([
				messageStartEvent(),
				{
					type: 'content_block_start',
					index: 0,
					content_block: { type: 'thinking', thinking: '', signature: '' },
				} as unknown as MessageStreamEvent,
				{
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'thinking_delta', thinking: 'Let me consider' },
				} as unknown as MessageStreamEvent,
				{ type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent,
				{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } } as unknown as MessageStreamEvent,
				{ type: 'message_stop' } as unknown as MessageStreamEvent,
			]),
			'claude-sonnet-4-5',
		);
		const events = await collect(llm.chat({ messages: [] }));
		const thinking = events.find((e) => e.type === 'thinking_delta');
		expect(thinking).toEqual({ type: 'thinking_delta', delta: 'Let me consider' });
	});

	it('finalizes tool calls on content_block_stop', async () => {
		const llm = new AnthropicLLM(
			fakeAnthropic([
				messageStartEvent(),
				{
					type: 'content_block_start',
					index: 0,
					content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} },
				} as unknown as MessageStreamEvent,
				{
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'input_json_delta', partial_json: '{"q":"' },
				} as unknown as MessageStreamEvent,
				{
					type: 'content_block_delta',
					index: 0,
					delta: { type: 'input_json_delta', partial_json: 'cats"}' },
				} as unknown as MessageStreamEvent,
				{ type: 'content_block_stop', index: 0 } as unknown as MessageStreamEvent,
				{ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } } as unknown as MessageStreamEvent,
				{ type: 'message_stop' } as unknown as MessageStreamEvent,
			]),
			'claude-sonnet-4-5',
		);
		const events = await collect(llm.chat({ messages: [] }));
		const finalized = events.find((e) => e.type === 'tool_call');
		expect(finalized).toEqual({ type: 'tool_call', id: 'toolu_1', name: 'web_search', input: { q: 'cats' } });
	});

	it('passes thinking budget to the SDK', async () => {
		const capture: { params?: { thinking?: { type: string; budget_tokens?: number } } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
		await collect(
			llm.chat({
				messages: [{ role: 'user', content: 'hi' }],
				thinking: { type: 'enabled', budgetTokens: 5000 },
			}),
		);
		expect(capture.params?.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
	});

	it('passes reasoning max_tokens as native thinking to the SDK', async () => {
		const capture: { params?: { thinking?: { type: string; budget_tokens?: number } } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
		await collect(
			llm.chat({
				messages: [{ role: 'user', content: 'hi' }],
				reasoning: { type: 'max_tokens', maxTokens: 5000 },
			}),
		);
		expect(capture.params?.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 });
	});

	it('applies cache_control to system when requested', async () => {
		const capture: { params?: { system?: unknown } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
		await collect(
			llm.chat({
				messages: [{ role: 'user', content: 'hi' }],
				systemPrompt: 'you are helpful',
				cacheControl: { type: 'ephemeral' },
			}),
		);
		expect(capture.params?.system).toEqual([
			{ type: 'text', text: 'you are helpful', cache_control: { type: 'ephemeral' } },
		]);
	});

	it('emits error event on stream failure', async () => {
		const broken = {
			messages: {
				stream() {
					throw new Error('boom');
				},
			},
		} as unknown as Anthropic;
		const llm = new AnthropicLLM(broken, 'claude-sonnet-4-5');
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toEqual([{ type: 'error', message: 'boom' }]);
	});

	it('returns the system prompt as a plain string when no cache control is set', async () => {
		const capture: { params?: { system?: unknown } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
		await collect(llm.chat({ messages: [], systemPrompt: 'plain prompt' }));
		expect(capture.params?.system).toBe('plain prompt');
	});

	it('omits the system field entirely when no system prompt is provided', async () => {
		const capture: { params?: { system?: unknown } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
		await collect(llm.chat({ messages: [] }));
		expect(capture.params?.system).toBeUndefined();
	});

	it('passes tools and tags the last one with cache_control when ephemeral', async () => {
		const capture: { params?: { tools?: Array<{ name: string; cache_control?: unknown }> } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
		await collect(
			llm.chat({
				messages: [],
				tools: [
					{ name: 'a', description: 'A', inputSchema: { type: 'object' } },
					{ name: 'b', description: 'B', inputSchema: { type: 'object' } },
				],
				cacheControl: { type: 'ephemeral' },
			}),
		);
		const tools = capture.params?.tools ?? [];
		expect(tools).toHaveLength(2);
		expect(tools[0].cache_control).toBeUndefined();
		expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
	});

	it('forwards image, thinking, and tool_use/tool_result blocks to anthropic shape', async () => {
		const capture: { params?: { messages?: Array<{ content: Array<Record<string, unknown>> }> } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
		await collect(
			llm.chat({
				messages: [
					{ role: 'user', content: [{ type: 'image', mimeType: 'image/jpeg', data: 'AAA' }] },
					{ role: 'assistant', content: [{ type: 'thinking', text: 'planning' }] },
					{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } }] },
					{ role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
					{ role: 'tool', content: [{ type: 'tool_result', toolUseId: 't2', content: 'fail', isError: true }] },
				],
			}),
		);
		const blocks = capture.params?.messages?.flatMap((m) => m.content) ?? [];
		const types = blocks.map((b) => b.type);
		expect(types).toContain('image');
		expect(types).toContain('thinking');
		expect(types).toContain('tool_use');
		expect(types).toContain('tool_result');
		const errResult = blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === 't2');
		expect(errResult?.is_error).toBe(true);
	});

	it('ignores unknown block types instead of crashing', async () => {
		const capture: { params?: { messages?: Array<{ content: unknown[] }> } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
		await collect(
			llm.chat({
				messages: [
					{
						role: 'user',
						content: [
							{ type: 'text', text: 'kept' },
							{ type: 'file', mimeType: 'application/pdf', data: 'AAA' },
						],
					},
				],
			}),
		);
		const blocks = (capture.params?.messages?.[0].content ?? []) as Array<{ type: string }>;
		expect(blocks.map((b) => b.type)).toEqual(['text']);
	});

	it('reports errors thrown mid-stream', async () => {
		const broken = {
			messages: {
				stream() {
					return (async function* () {
						yield messageStartEvent();
						throw new Error('mid-stream boom');
					})();
				},
			},
		} as unknown as Anthropic;
		const llm = new AnthropicLLM(broken, 'claude-sonnet-4-5');
		const events = await collect(llm.chat({ messages: [] }));
		const err = events.find((e) => e.type === 'error');
		expect(err).toEqual({ type: 'error', message: 'mid-stream boom' });
	});

	it('serializes non-Error throw values', async () => {
		const broken = {
			messages: {
				stream() {
					throw { weird: 'object' };
				},
			},
		} as unknown as Anthropic;
		const llm = new AnthropicLLM(broken, 'claude-sonnet-4-5');
		const events = await collect(llm.chat({ messages: [] }));
		const err = events.find((e) => e.type === 'error');
		expect((err as { message: string }).message).toContain('weird');
	});

	it('flattens text-only content blocks correctly', async () => {
		const capture: { params?: { messages?: Array<{ role: string; content: unknown }> } } = {};
		const llm = new AnthropicLLM(
			fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture),
			'claude-sonnet-4-5',
		);
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
		expect(capture.params?.messages?.[0].content).toEqual([
			{ type: 'text', text: 'a' },
			{ type: 'text', text: 'b' },
		]);
	});
});
