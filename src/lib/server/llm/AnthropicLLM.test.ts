import type Anthropic from '@anthropic-ai/sdk';
import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import { describe, expect, it } from 'vitest';
import { assertDefined } from '../../../../test/assert-defined';
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
		message: {
			content: [],
			id: 'msg_1',
			model: 'claude-sonnet-4-5',
			role: 'assistant',
			stop_reason: null,
			stop_sequence: null,
			type: 'message',
			usage: {
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				input_tokens: input,
				output_tokens: output,
				server_tool_use: null,
				service_tier: null,
			},
		},
		type: 'message_start',
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
				{ content_block: { text: '', type: 'text' }, index: 0, type: 'content_block_start' } as unknown as MessageStreamEvent,
				{ delta: { text: 'Hello', type: 'text_delta' }, index: 0, type: 'content_block_delta' } as unknown as MessageStreamEvent,
				{ delta: { text: ' world', type: 'text_delta' }, index: 0, type: 'content_block_delta' } as unknown as MessageStreamEvent,
				{ index: 0, type: 'content_block_stop' } as unknown as MessageStreamEvent,
				{
					delta: { stop_reason: 'end_turn', stop_sequence: null },
					type: 'message_delta',
					usage: { output_tokens: 50 },
				} as unknown as MessageStreamEvent,
				{ type: 'message_stop' } as unknown as MessageStreamEvent,
			]),
			'claude-sonnet-4-5',
		);
		const events = await collect(llm.chat({ messages: [{ content: 'hi', role: 'user' }] }));
		const texts = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
		expect(texts).toEqual(['Hello', ' world']);
		const usage = events.find((e) => e.type === 'usage');
		expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
		expect(events.at(-1)).toEqual({ finishReason: 'end_turn', type: 'done' });
	});

	it('emits thinking_delta for thinking blocks', async () => {
		const llm = new AnthropicLLM(
			fakeAnthropic([
				messageStartEvent(),
				{
					content_block: { signature: '', thinking: '', type: 'thinking' },
					index: 0,
					type: 'content_block_start',
				} as unknown as MessageStreamEvent,
				{
					delta: { thinking: 'Let me consider', type: 'thinking_delta' },
					index: 0,
					type: 'content_block_delta',
				} as unknown as MessageStreamEvent,
				{ index: 0, type: 'content_block_stop' } as unknown as MessageStreamEvent,
				{
					delta: { stop_reason: 'end_turn', stop_sequence: null },
					type: 'message_delta',
					usage: { output_tokens: 10 },
				} as unknown as MessageStreamEvent,
				{ type: 'message_stop' } as unknown as MessageStreamEvent,
			]),
			'claude-sonnet-4-5',
		);
		const events = await collect(llm.chat({ messages: [] }));
		const thinking = events.find((e) => e.type === 'thinking_delta');
		expect(thinking).toEqual({ delta: 'Let me consider', type: 'thinking_delta' });
	});

	it('emits a thinking_signature event when Anthropic delivers a signature_delta', async () => {
		// Regression: signatures were never captured, so round-tripped thinking
		// blocks went out with `signature: ''` and Anthropic 400'd the next
		// turn whenever thinking was interleaved with tool calls.
		const llm = new AnthropicLLM(
			fakeAnthropic([
				messageStartEvent(),
				{
					content_block: { signature: '', thinking: '', type: 'thinking' },
					index: 0,
					type: 'content_block_start',
				} as unknown as MessageStreamEvent,
				{
					delta: { thinking: 'Let me consider', type: 'thinking_delta' },
					index: 0,
					type: 'content_block_delta',
				} as unknown as MessageStreamEvent,
				{
					delta: { signature: 'auth-blob-abc', type: 'signature_delta' },
					index: 0,
					type: 'content_block_delta',
				} as unknown as MessageStreamEvent,
				{ index: 0, type: 'content_block_stop' } as unknown as MessageStreamEvent,
				{
					delta: { stop_reason: 'end_turn', stop_sequence: null },
					type: 'message_delta',
					usage: { output_tokens: 10 },
				} as unknown as MessageStreamEvent,
				{ type: 'message_stop' } as unknown as MessageStreamEvent,
			]),
			'claude-sonnet-4-5',
		);
		const events = await collect(llm.chat({ messages: [] }));
		const sig = events.find((e) => e.type === 'thinking_signature');
		expect(sig).toEqual({ signature: 'auth-blob-abc', type: 'thinking_signature' });
	});

	it('drops thinking blocks without a signature when round-tripping (defense in depth)', async () => {
		// Regression: `blocksToAnthropic` used to fabricate `signature: ''` for
		// signatureless thinking blocks, which Anthropic rejects. Sanitize
		// strips them upstream now, but the adapter must also refuse to forge.
		const capture: { params?: { messages?: Array<{ content: Array<Record<string, unknown>> }> } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				messages: [{ content: [{ text: 'planning', type: 'thinking' }], role: 'assistant' }],
			}),
		);
		const blocks = capture.params?.messages?.flatMap((m) => m.content) ?? [];
		// The thinking block had no signature, so `blocksToAnthropic` must have
		// dropped it rather than emitting `{ signature: '' }`.
		expect(blocks.find((b) => b.type === 'thinking')).toBeUndefined();
	});

	it('round-trips a captured thinking signature back to the SDK', async () => {
		const capture: { params?: { messages?: Array<{ content: Array<Record<string, unknown>> }> } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				messages: [
					{
						content: [{ signature: 'auth-blob-abc', text: 'planning', type: 'thinking' }],
						role: 'assistant',
					},
				],
			}),
		);
		const blocks = capture.params?.messages?.flatMap((m) => m.content) ?? [];
		const thinking = blocks.find((b) => b.type === 'thinking') as { signature?: string } | undefined;
		expect(thinking?.signature).toBe('auth-blob-abc');
	});

	it('finalizes tool calls on content_block_stop', async () => {
		const llm = new AnthropicLLM(
			fakeAnthropic([
				messageStartEvent(),
				{
					content_block: { id: 'toolu_1', input: {}, name: 'web_search', type: 'tool_use' },
					index: 0,
					type: 'content_block_start',
				} as unknown as MessageStreamEvent,
				{
					delta: { partial_json: '{"q":"', type: 'input_json_delta' },
					index: 0,
					type: 'content_block_delta',
				} as unknown as MessageStreamEvent,
				{
					delta: { partial_json: 'cats"}', type: 'input_json_delta' },
					index: 0,
					type: 'content_block_delta',
				} as unknown as MessageStreamEvent,
				{ index: 0, type: 'content_block_stop' } as unknown as MessageStreamEvent,
				{
					delta: { stop_reason: 'tool_use', stop_sequence: null },
					type: 'message_delta',
					usage: { output_tokens: 30 },
				} as unknown as MessageStreamEvent,
				{ type: 'message_stop' } as unknown as MessageStreamEvent,
			]),
			'claude-sonnet-4-5',
		);
		const events = await collect(llm.chat({ messages: [] }));
		const finalized = events.find((e) => e.type === 'tool_call');
		expect(finalized).toEqual({ id: 'toolu_1', input: { q: 'cats' }, name: 'web_search', type: 'tool_call' });
	});

	it('passes thinking budget to the SDK', async () => {
		const capture: { params?: { thinking?: { type: string; budget_tokens?: number } } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				messages: [{ content: 'hi', role: 'user' }],
				thinking: { budgetTokens: 5000, type: 'enabled' },
			}),
		);
		expect(capture.params?.thinking).toEqual({ budget_tokens: 5000, type: 'enabled' });
	});

	it('passes reasoning max_tokens as native thinking to the SDK', async () => {
		const capture: { params?: { thinking?: { type: string; budget_tokens?: number } } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				messages: [{ content: 'hi', role: 'user' }],
				reasoning: { maxTokens: 5000, type: 'max_tokens' },
			}),
		);
		expect(capture.params?.thinking).toEqual({ budget_tokens: 5000, type: 'enabled' });
	});

	it('passes thinking disabled to the SDK when thinking type is disabled', async () => {
		// Regression: { type: 'disabled' } was never forwarded — AnthropicLLM only
		// handled 'enabled'. The disabled shape must be sent explicitly so the API
		// receives an unambiguous signal when a thinking-capable model has thinking off.
		const capture: { params?: { thinking?: { type: string } } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-6');
		await collect(
			llm.chat({
				messages: [{ content: 'hi', role: 'user' }],
				thinking: { type: 'disabled' },
			}),
		);
		expect(capture.params?.thinking).toEqual({ type: 'disabled' });
	});

	it('applies cache_control to system when requested', async () => {
		const capture: { params?: { system?: unknown } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				cacheControl: { type: 'ephemeral' },
				messages: [{ content: 'hi', role: 'user' }],
				systemPrompt: 'you are helpful',
			}),
		);
		expect(capture.params?.system).toEqual([{ cache_control: { type: 'ephemeral' }, text: 'you are helpful', type: 'text' }]);
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
		expect(events).toEqual([{ message: 'boom', type: 'error' }]);
	});

	it('returns the system prompt as a plain string when no cache control is set', async () => {
		const capture: { params?: { system?: unknown } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(llm.chat({ messages: [], systemPrompt: 'plain prompt' }));
		expect(capture.params?.system).toBe('plain prompt');
	});

	it('omits the system field entirely when no system prompt is provided', async () => {
		const capture: { params?: { system?: unknown } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(llm.chat({ messages: [] }));
		expect(capture.params?.system).toBeUndefined();
	});

	it('passes tools and tags the last one with cache_control when ephemeral', async () => {
		const capture: { params?: { tools?: Array<{ name: string; cache_control?: unknown }> } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				cacheControl: { type: 'ephemeral' },
				messages: [],
				tools: [
					{ description: 'A', inputSchema: { type: 'object' }, name: 'a' },
					{ description: 'B', inputSchema: { type: 'object' }, name: 'b' },
				],
			}),
		);
		const tools = capture.params?.tools ?? [];
		expect(tools).toHaveLength(2);
		expect(tools[0].cache_control).toBeUndefined();
		expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
	});

	it('forwards image, thinking, and tool_use/tool_result blocks to anthropic shape', async () => {
		const capture: { params?: { messages?: Array<{ content: Array<Record<string, unknown>> }> } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				messages: [
					{ content: [{ data: 'AAA', mimeType: 'image/jpeg', type: 'image' }], role: 'user' },
					{ content: [{ signature: 'sig', text: 'planning', type: 'thinking' }], role: 'assistant' },
					{ content: [{ id: 't1', input: { a: 1 }, name: 'x', type: 'tool_use' }], role: 'assistant' },
					{ content: [{ content: 'ok', toolUseId: 't1', type: 'tool_result' }], role: 'tool' },
					{ content: [{ content: 'fail', isError: true, toolUseId: 't2', type: 'tool_result' }], role: 'tool' },
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

	it('passes array tool_result content (text + image) through to the SDK shape', async () => {
		// Anthropic tool_result.content natively accepts a string or an array
		// of text/image blocks. Regression: keep the array form passing through
		// untouched so `sandbox_load_image` lands an image inline in the
		// next-turn history rather than getting stringified.
		const capture: { params?: { messages?: Array<{ content: Array<Record<string, unknown>> }> } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				messages: [
					{ content: [{ id: 't1', input: {}, name: 'sandbox_load_image', type: 'tool_use' }], role: 'assistant' },
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
		const messages = capture.params?.messages ?? [];
		const toolMsg = messages[messages.length - 1];
		const toolResult = toolMsg.content.find((b) => b.type === 'tool_result') as { content: Array<Record<string, unknown>> } | undefined;
		expect(Array.isArray(toolResult?.content)).toBe(true);
		assertDefined(toolResult);
		const inner = toolResult.content;
		expect(inner).toContainEqual({ text: 'Loaded photo.png.', type: 'text' });
		expect(inner).toContainEqual({
			source: { data: 'AAAA', media_type: 'image/png', type: 'base64' },
			type: 'image',
		});
	});

	it('ignores unknown block types instead of crashing', async () => {
		const capture: { params?: { messages?: Array<{ content: unknown[] }> } } = {};
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				messages: [
					{
						content: [
							{ text: 'kept', type: 'text' },
							{ data: 'AAA', mimeType: 'application/pdf', type: 'file' },
						],
						role: 'user',
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
		expect(err).toEqual({ message: 'mid-stream boom', type: 'error' });
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
		const llm = new AnthropicLLM(fakeAnthropic([{ type: 'message_stop' } as unknown as MessageStreamEvent], capture), 'claude-sonnet-4-5');
		await collect(
			llm.chat({
				messages: [
					{
						content: [
							{ text: 'a', type: 'text' },
							{ text: 'b', type: 'text' },
						],
						role: 'user',
					},
				],
			}),
		);
		expect(capture.params?.messages?.[0].content).toEqual([
			{ text: 'a', type: 'text' },
			{ text: 'b', type: 'text' },
		]);
	});
});
