// End-to-end integration tests through the conversation Durable Object.
// These cover composition concerns (LLM history shape across multi-turn,
// MCP tool dispatch, SSE → state, optimistic-creation race) that the
// per-module test files don't.

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversation } from '../conversations';
import { createMcpServer } from '../mcp_servers';
import { setSetting } from '../settings';
import { textTurn, toolUseTurn } from '../../../../test/fakes/FakeLLM';
import {
	readLLMCalls,
	readState,
	setOverride,
	stubFor,
	waitForState,
} from './conversation/_test-helpers';
import type { ContentBlock } from '../llm/LLM';
import type { ToolResultPart, ToolUsePart } from '$lib/types/conversation';

afterEach(async () => {
	vi.restoreAllMocks();
	await env.DB.prepare('DELETE FROM mcp_servers').run();
	await env.DB.prepare('DELETE FROM conversations').run();
	await env.DB.prepare('DELETE FROM memories').run();
	await env.DB.prepare('DELETE FROM settings').run();
});

describe('ConversationDurableObject — full SSE + generate flow', () => {
	it('subscribe receives a refresh and delta event flow as generation completes', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await setOverride(stub, [textTurn('done').events]);

		const stream = await stub.subscribe();
		const reader = stream.getReader();
		const decoder = new TextDecoder();

		const result = await stub.addUserMessage(id, 'hi', 'fake/model');
		expect(result).toEqual({ status: 'started' });

		// Drain frames until we've seen both a refresh and a delta carrying the
		// final assistant text. The DO broadcasts `refresh` when the user/asst
		// rows are seeded and `delta` for each text chunk during generation.
		let buffer = '';
		const deadline = Date.now() + 5000;
		while (
			Date.now() < deadline &&
			!(buffer.includes('event: refresh') && buffer.includes('event: delta'))
		) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) buffer += decoder.decode(value, { stream: true });
		}
		await reader.cancel();
		expect(buffer).toContain('event: refresh');
		expect(buffer).toContain('event: delta');
		expect(buffer).toContain('"content":"done"');

		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', { timeoutMs: 2000 });
		const state = await readState(stub);
		const last = state.messages.at(-1)!;
		expect(last.role).toBe('assistant');
		expect(last.content).toBe('done');
	});
});

describe('ConversationDurableObject — multi-turn tool loop', () => {
	it('the second LLM call sees the tool_result for the first call in its history', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// Turn 1: model asks to remember something. Turn 2: model emits final text.
		await setOverride(stub, [
			toolUseTurn('t1', 'remember', { content: 'I prefer brief replies' }).events,
			textTurn('saved').events,
		]);

		await stub.addUserMessage(id, 'remember this', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', { timeoutMs: 5000 });

		const calls = await readLLMCalls(stub);
		expect(calls).toHaveLength(2);
		// The second call's messages must include a tool-role entry whose
		// `tool_result` block matches the first call's `tool_use` id.
		const turn2 = calls[1];
		const toolMsg = turn2.messages.find((m) => m.role === 'tool');
		expect(toolMsg).toBeTruthy();
		const blocks = (toolMsg!.content as ContentBlock[]).filter(
			(b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
		);
		expect(blocks.some((b) => b.toolUseId === 't1')).toBe(true);
	});
});

describe('ConversationDurableObject — MCP tool integration', () => {
	it('mounts mcp_<id>_echo, dispatches a tool_call to the upstream server, and ingests the result', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);

		// Register an enabled HTTP MCP server.
		const serverId = await createMcpServer(env, {
			name: 'demo',
			transport: 'http',
			url: 'https://mcp.example.com/server',
		});
		const namespacedTool = `mcp_${serverId}_echo`;

		// Mock the JSON-RPC POSTs by URL+method so a re-run on the same URL
		// gets the right shape regardless of order.
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const url = String(input);
			const body = init?.body ? JSON.parse(String(init.body)) : null;
			if (url === 'https://mcp.example.com/server' && body?.method === 'tools/list') {
				return new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: body.id,
						result: {
							tools: [
								{
									name: 'echo',
									description: 'Echo input back',
									inputSchema: {
										type: 'object',
										properties: { text: { type: 'string' } },
										required: ['text'],
									},
								},
							],
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (url === 'https://mcp.example.com/server' && body?.method === 'tools/call') {
				return new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: body.id,
						result: { content: [{ type: 'text', text: 'echoed: hi MCP' }] },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			throw new Error(`unexpected fetch ${url} ${body?.method}`);
		});

		await setOverride(stub, [
			toolUseTurn('m1', namespacedTool, { text: 'hi MCP' }).events,
			textTurn('all done').events,
		]);

		await stub.addUserMessage(id, 'use the MCP tool', 'fake/model');
		const state = await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete', {
			timeoutMs: 5000,
		});

		// Two upstream MCP calls: list, then call.
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const bodies = fetchSpy.mock.calls.map(
			(c) => JSON.parse((c[1] as RequestInit).body as string) as { method: string; params?: unknown },
		);
		expect(bodies.map((b) => b.method)).toEqual(['tools/list', 'tools/call']);
		const callParams = bodies[1].params as { name: string; arguments: { text: string } };
		expect(callParams.name).toBe('echo');
		expect(callParams.arguments).toEqual({ text: 'hi MCP' });

		// Final assistant message has the tool_use + tool_result + text.
		const last = state.messages.at(-1)!;
		const toolUse = last.parts?.find((p): p is ToolUsePart => p.type === 'tool_use');
		const toolResult = last.parts?.find((p): p is ToolResultPart => p.type === 'tool_result');
		expect(toolUse?.name).toBe(namespacedTool);
		expect(toolResult?.content).toContain('echoed: hi MCP');
		expect(toolResult?.isError).toBeFalsy();
	});
});

describe('ConversationDurableObject — compactContext', () => {
	it('inserts a summary info part and soft-deletes the dropped messages', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// Seed several user/assistant rounds with large content so the LLM
		// estimate exceeds the 50%-of-128k force-compact ceiling. Each pair
		// is ~28k chars (~7700 tokens); 12 messages ≈ 92k tokens, well above
		// 64k. compactContext routes to the real `routeLLMByGlobalId` (no
		// override path), so we expect it to throw and fall back to the
		// raw-text summary, which is still non-empty as long as we drop
		// something.
		const filler = 'lorem ipsum dolor sit amet '.repeat(1000); // ~27k chars
		await runInDurableObject(stub, async (_instance, ctx) => {
			for (let i = 0; i < 6; i++) {
				ctx.storage.sql.exec(
					"INSERT INTO messages (id, role, content, model, status, created_at) VALUES (?, 'user', ?, NULL, 'complete', ?)",
					`u${i}`,
					`q${i} ${filler}`,
					100 + i * 2,
				);
				ctx.storage.sql.exec(
					"INSERT INTO messages (id, role, content, model, status, created_at) VALUES (?, 'assistant', ?, 'fake/model', 'complete', ?)",
					`a${i}`,
					`a${i} ${filler}`,
					100 + i * 2 + 1,
				);
			}
		});

		const result = await stub.compactContext(id);
		expect(result.compacted).toBe(true);
		expect(result.droppedCount).toBeGreaterThan(0);

		const state = await readState(stub);
		const summary = state.messages.find((m) =>
			m.parts?.some((p) => p.type === 'info' && p.text.includes('Context compacted')),
		);
		expect(summary).toBeTruthy();
		// At least the most-recent two exchanges (4 messages) are kept.
		const remainingNonSummary = state.messages.filter(
			(m) => !m.parts?.some((p) => p.type === 'info'),
		);
		expect(remainingNonSummary.length).toBeGreaterThanOrEqual(4);
	});

	it('returns { compacted: false } when an in-progress generation is running', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// Override with a turn that emits a delta but never `done` — leaves
		// the DO in an inProgress state.
		await setOverride(stub, [[{ type: 'text_delta', delta: 'partial' }]]);
		await stub.addUserMessage(id, 'hi', 'fake/model');
		const result = await stub.compactContext(id);
		expect(result).toEqual({ compacted: false, droppedCount: 0 });
	});
});

describe('ConversationDurableObject — abort flow', () => {
	it('abortGeneration cancels an in-flight generation and writes a complete row', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// Slow turn: emits a delta but never finishes.
		await setOverride(stub, [[{ type: 'text_delta', delta: 'half-done' }]]);
		await stub.addUserMessage(id, 'go', 'fake/model');
		// Wait until the assistant row exists and is streaming.
		await waitForState(stub, (s) => s.messages.some((m) => m.role === 'assistant'), {
			timeoutMs: 2000,
		});
		await stub.abortGeneration(id);
		const state = await readState(stub);
		const last = state.messages.at(-1)!;
		expect(last.role).toBe('assistant');
		expect(last.status).toBe('complete');
		expect(state.inProgress).toBeNull();
	});
});
