import { describe, expect, it } from 'vitest';
import { CloudflareWorkersAILLM } from './CloudflareWorkersAILLM';
import type { StreamEvent } from './LLM';

// Build a fake `Ai` binding whose `run()` returns a ReadableStream emitting
// the given list of SSE events. Each event is a string already formatted as
// "data: {...}\n\n" (or "data: [DONE]\n\n").
function fakeAI(events: string[], capture?: { params?: unknown; opts?: unknown; model?: string }): Ai {
	return {
		run: async (model: string, params: unknown, opts?: unknown) => {
			if (capture) {
				capture.model = model;
				capture.params = params;
				capture.opts = opts;
			}
			return new ReadableStream<Uint8Array>({
				start(controller) {
					const enc = new TextEncoder();
					for (const ev of events) controller.enqueue(enc.encode(ev));
					controller.close();
				},
			});
		},
	} as unknown as Ai;
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

function sse(obj: unknown): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('CloudflareWorkersAILLM', () => {
	it('exposes model and providerID', () => {
		const llm = new CloudflareWorkersAILLM(fakeAI([]), '@cf/meta/llama-3.3-70b-instruct-fp8-fast', null);
		expect(llm.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
		expect(llm.providerID).toBe('cloudflare-workers-ai');
	});

	it('emits text_delta events from native Workers AI {response} chunks', async () => {
		const ai = fakeAI([
			sse({ response: 'Hello' }),
			sse({ response: ', world' }),
			sse({ response: '!' }),
			'data: [DONE]\n\n',
		]);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', null);
		const events = await collect(llm.chat({ messages: [{ role: 'user', content: 'hi' }] }));
		const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
		expect(deltas).toEqual(['Hello', ', world', '!']);
		expect(events.at(-1)?.type).toBe('done');
	});

	it('emits text_delta events from OpenAI-compat {choices: [{delta}]} chunks (gpt-oss)', async () => {
		const ai = fakeAI([
			sse({ choices: [{ delta: { content: 'Hi' } }] }),
			sse({ choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] }),
			'data: [DONE]\n\n',
		]);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/openai/gpt-oss-120b', null);
		const events = await collect(llm.chat({ messages: [] }));
		const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
		expect(deltas).toEqual(['Hi', ' there']);
		const done = events.at(-1) as { type: string; finishReason?: string };
		expect(done.type).toBe('done');
		expect(done.finishReason).toBe('stop');
	});

	it('emits thinking_delta for reasoning_content (OpenAI-compat path)', async () => {
		const ai = fakeAI([
			sse({ choices: [{ delta: { reasoning_content: 'Think...' } }] }),
			sse({ choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] }),
			'data: [DONE]\n\n',
		]);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/openai/gpt-oss-120b', null);
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toContainEqual({ type: 'thinking_delta', delta: 'Think...' });
	});

	it('emits usage event from {usage} field', async () => {
		const ai = fakeAI([
			sse({ response: 'hi' }),
			sse({ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
			'data: [DONE]\n\n',
		]);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/x', null);
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toContainEqual({
			type: 'usage',
			usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
		});
	});

	it('finalizes streaming OpenAI-compat tool calls', async () => {
		const ai = fakeAI([
			sse({
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"q":"' } },
							],
						},
					},
				],
			}),
			sse({
				choices: [
					{ delta: { tool_calls: [{ index: 0, function: { arguments: 'cats"}' } }] } },
				],
			}),
			sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
			'data: [DONE]\n\n',
		]);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/openai/gpt-oss-120b', null);
		const events = await collect(llm.chat({ messages: [] }));
		const finalCall = events.find((e) => e.type === 'tool_call');
		expect(finalCall).toEqual({
			type: 'tool_call',
			id: 'call_1',
			name: 'web_search',
			input: { q: 'cats' },
		});
	});

	it('emits tool_call from native shape tool_calls array', async () => {
		const ai = fakeAI([
			sse({ response: '' }),
			sse({
				tool_calls: [{ id: 'cf_1', name: 'web_search', arguments: { q: 'cats' } }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
			'data: [DONE]\n\n',
		]);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', null);
		const events = await collect(llm.chat({ messages: [] }));
		const finalCall = events.find((e) => e.type === 'tool_call');
		expect(finalCall).toEqual({
			type: 'tool_call',
			id: 'cf_1',
			name: 'web_search',
			input: { q: 'cats' },
		});
	});

	it('passes the gateway id to env.AI.run when configured', async () => {
		const capture: { opts?: unknown } = {};
		const ai = fakeAI(['data: [DONE]\n\n'], capture);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/x', 'my-gateway');
		await collect(llm.chat({ messages: [] }));
		expect(capture.opts).toEqual({ gateway: { id: 'my-gateway' } });
	});

	it('omits the gateway opt when no id is configured', async () => {
		const capture: { opts?: unknown } = {};
		const ai = fakeAI(['data: [DONE]\n\n'], capture);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/x', null);
		await collect(llm.chat({ messages: [] }));
		expect(capture.opts).toBeUndefined();
	});

	it('forwards system prompt as the first message', async () => {
		const capture: { params?: { messages?: Array<{ role: string; content: unknown }> } } = {};
		const ai = fakeAI(['data: [DONE]\n\n'], capture);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/x', null);
		await collect(llm.chat({ systemPrompt: 'be nice', messages: [{ role: 'user', content: 'hi' }] }));
		expect(capture.params!.messages![0]).toEqual({ role: 'system', content: 'be nice' });
		expect(capture.params!.messages![1]).toEqual({ role: 'user', content: 'hi' });
	});

	it('serializes assistant tool_use blocks to OpenAI-style tool_calls', async () => {
		const capture: { params?: { messages?: Array<{ role: string; content: unknown; tool_calls?: unknown }> } } = {};
		const ai = fakeAI(['data: [DONE]\n\n'], capture);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/x', null);
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

	it('passes tool definitions to env.AI.run', async () => {
		const capture: { params?: { tools?: unknown[] } } = {};
		const ai = fakeAI(['data: [DONE]\n\n'], capture);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/x', null);
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

	it('emits an error event when env.AI.run throws', async () => {
		const ai = {
			run: async () => {
				throw new Error('boom');
			},
		} as unknown as Ai;
		const llm = new CloudflareWorkersAILLM(ai, '@cf/x', null);
		const events = await collect(llm.chat({ messages: [] }));
		expect(events).toEqual([{ type: 'error', message: 'boom' }]);
	});

	it('handles SSE events that span multiple chunks', async () => {
		// One event split across two enqueues.
		const events = [`data: {"response":"par`, `tial"}\n\n`, 'data: [DONE]\n\n'];
		const ai = fakeAI(events);
		const llm = new CloudflareWorkersAILLM(ai, '@cf/x', null);
		const out = await collect(llm.chat({ messages: [] }));
		const deltas = out.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
		expect(deltas).toEqual(['partial']);
	});
});
