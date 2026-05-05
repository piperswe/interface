import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import { textTurn, toolUseTurn } from '../../../../test/fakes/FakeLLM';
import { setOverride, stubFor, waitForState } from './conversation/_test-helpers';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('ConversationDurableObject — #generate (FakeLLM)', () => {
	it('streams a text-only turn through to a complete assistant message', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await setOverride(stub, [textTurn('hello back').events]);

		const result = await stub.addUserMessage(id, 'hi', 'fake/model');
		expect(result).toEqual({ status: 'started' });

		const state = await waitForState(stub, (s) => {
			const last = s.messages.at(-1);
			return last?.status === 'complete';
		});
		expect(state.messages).toHaveLength(3);
		expect(state.messages[0]).toMatchObject({ role: 'system' });
		expect(state.messages[1]).toMatchObject({ role: 'user', content: 'hi' });
		expect(state.messages[2]).toMatchObject({ role: 'assistant', status: 'complete', content: 'hello back' });
		expect(state.inProgress).toBeNull();
	});

	it('appends an info part when MAX_TOOL_ITERATIONS runs out', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// 11 tool-emitting turns guarantees we hit the cap (which is 10).
		const script = Array.from({ length: 11 }, (_, i) => toolUseTurn(`call${i}`, 'unknown_tool', { i }).events);
		await setOverride(stub, script);

		await stub.addUserMessage(id, 'use a tool repeatedly', 'fake/model');
		const state = await waitForState(stub, (s) => {
			const last = s.messages.at(-1);
			return last?.status === 'complete';
		}, { timeoutMs: 10_000 });
		const last = state.messages.at(-1)!;
		const infoParts = (last.parts ?? []).filter((p) => p.type === 'info');
		expect(infoParts.length).toBeGreaterThanOrEqual(1);
		expect(infoParts.some((p) => p.type === 'info' && p.text.includes('iteration budget'))).toBe(true);
		// Every tool_use part must have a matching tool_result so the next
		// turn's history is well-formed.
		const useIds = (last.parts ?? [])
			.filter((p): p is import('$lib/types/conversation').ToolUsePart => p.type === 'tool_use')
			.map((p) => p.id);
		const resultIds = new Set(
			(last.parts ?? [])
				.filter((p): p is import('$lib/types/conversation').ToolResultPart => p.type === 'tool_result')
				.map((p) => p.toolUseId),
		);
		for (const id of useIds) expect(resultIds.has(id)).toBe(true);
	});

	it('persists raw content for completed assistant messages without server-rendered HTML', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await setOverride(stub, [textTurn('# heading\n\nbody').events]);

		await stub.addUserMessage(id, 'hi', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');

		await runInDurableObject(stub, async (_instance, ctx) => {
			const rows = ctx.storage.sql
				.exec("SELECT content, content_html FROM messages WHERE role = 'assistant'")
				.toArray() as unknown as Array<{ content: string; content_html: string | null }>;
			expect(rows).toHaveLength(1);
			expect(rows[0].content).toContain('# heading');
			// Markdown is rendered client-side; the server stores raw text only.
			expect(rows[0].content_html).toBeNull();
		});
	});

	it('schema version is recorded after migrations run', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			const rows = ctx.storage.sql
				.exec("SELECT value FROM _meta WHERE key = 'schema_version'")
				.toArray() as unknown as Array<{ value: string }>;
			expect(rows).toHaveLength(1);
			expect(Number(rows[0].value)).toBeGreaterThanOrEqual(2);
		});
	});

	it('records started_at and ended_at timestamps on tool_result parts', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// First turn: a tool call. Second turn: final text. We use the
		// built-in `remember` tool because its execution is fast and
		// deterministic — no network calls.
		await setOverride(stub, [
			toolUseTurn('t1', 'remember', { content: 'I prefer brief replies' }).events,
			textTurn('saved').events,
		]);
		await stub.addUserMessage(id, 'remember this', 'fake/model');
		const state = await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');
		const last = state.messages.at(-1)!;
		const toolUse = last.parts?.find((p) => p.type === 'tool_use' && p.id === 't1');
		const toolResult = last.parts?.find((p) => p.type === 'tool_result' && p.toolUseId === 't1');
		expect(toolUse).toBeTruthy();
		expect(toolResult).toBeTruthy();
		if (toolUse?.type === 'tool_use') {
			expect(typeof toolUse.startedAt).toBe('number');
			expect(toolUse.startedAt!).toBeGreaterThan(0);
		}
		if (toolResult?.type === 'tool_result') {
			expect(typeof toolResult.startedAt).toBe('number');
			expect(typeof toolResult.endedAt).toBe('number');
			expect(toolResult.endedAt!).toBeGreaterThanOrEqual(toolResult.startedAt!);
		}
		// Cleanup the memory the tool created so other tests start clean.
		await env.DB.prepare('DELETE FROM memories').run();
	});
});
