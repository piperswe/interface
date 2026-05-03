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
