import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import { textTurn, toolUseTurn } from '../../../../test/fakes/FakeLLM';
import { readState, setOverride, stubFor, waitForState } from './conversation/_test-helpers';
import type { ConversationStub } from './index';

// Methods on the DO that aren't part of the public RPC interface but are
// reachable through the stub for testing.
type WithToolBarrier = {
	__armToolExecBarrier(): Promise<number>;
	__releaseToolExecBarrier(slot: number): Promise<void>;
};
const barrierFor = (stub: ConversationStub) => stub as unknown as WithToolBarrier;

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

	// Regression: when the user clicks "stop" while a tool (e.g. a
	// long-running sandbox_exec) is in flight, abortGeneration sets
	// #inProgress = null and persists the row. Without the post-exec guard,
	// the tool loop kept running after registry.execute returned: it
	// updated `parts` with the late-arriving result, called
	// `this.#cancelFlush()` (which would torch a follow-up turn's pending
	// flush timer), and wrote `this.#inProgress!.content` back into the DB
	// — either crashing (if nothing else was in progress) or smearing the
	// new turn's state across the aborted row.
	//
	// To make the corruption deterministic we hold the aborted turn at the
	// tool barrier, fire abortGeneration, queue a follow-up turn that ALSO
	// blocks at its own tool barrier (so #inProgress stays set to the new
	// message's id), then release the original barrier. With the bug
	// present this overwrites the aborted row's tool_result with the
	// late `remember` output. With the fix the guard short-circuits.
	it('abortGeneration mid-tool keeps the aborted message intact when the tool later completes', { timeout: 15_000 }, async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		// First two turns call `remember` so we can park each generation at
		// its own barrier and control the resume order precisely. The
		// remaining turns are extras: after the aborted turn's guard short-
		// circuits its tool loop the outer iteration loop falls through to
		// another `llm.chat()` call (and consumes a turn) before its inner
		// guard breaks out, so we leave a couple of harmless follow-ups in
		// the queue for both generations to drain.
		await setOverride(stub, [
			toolUseTurn('t1', 'remember', { content: 'I prefer brief replies' }).events,
			toolUseTurn('t2', 'remember', { content: 'and one more thing' }).events,
			textTurn('throwaway').events,
			textTurn('done').events,
			textTurn('extra').events,
		]);

		const slotA = await barrierFor(stub).__armToolExecBarrier();
		const started = await stub.addUserMessage(id, 'remember this', 'fake/model');
		expect(started).toEqual({ status: 'started' });

		// Wait until the tool loop publishes the preliminary streaming
		// tool_result. At that point #generate is parked at slotA's hold,
		// so a real abort lands while the tool is "in flight."
		const beforeAbort = await waitForState(stub, (s) => {
			const last = s.messages.at(-1);
			return (last?.parts ?? []).some((p) => p.type === 'tool_result' && p.streaming === true);
		});
		const abortedAssistantId = beforeAbort.messages.at(-1)!.id;

		await stub.abortGeneration(id);

		// Arm a second hold for the follow-up turn, then queue it. The
		// second generation will start, push the preliminary tool_result,
		// and park itself at slotB. While it's parked, #inProgress is set
		// to the follow-up's assistant message id — which is what makes
		// the unguarded `this.#inProgress!.content` write at the end of
		// the original tool loop scribble onto the wrong row.
		const slotB = await barrierFor(stub).__armToolExecBarrier();
		const followup = await stub.addUserMessage(id, 'second turn', 'fake/model');
		expect(followup).toEqual({ status: 'started' });

		await waitForState(stub, (s) => {
			const last = s.messages.at(-1);
			return (
				last?.id !== abortedAssistantId &&
				(last?.parts ?? []).some((p) => p.type === 'tool_result' && p.streaming === true)
			);
		});

		// Release the aborted turn's hold first. With the bug this lands
		// the late `remember` result on the aborted row.
		await barrierFor(stub).__releaseToolExecBarrier(slotA);
		// Release the follow-up turn so it can run to completion and the
		// test can synchronize on its terminal state.
		await barrierFor(stub).__releaseToolExecBarrier(slotB);

		await waitForState(stub, (s) => {
			const last = s.messages.at(-1);
			return last?.role === 'assistant' && last.status === 'complete';
		}, { timeoutMs: 5000 });

		const finalState = await readState(stub);
		const aborted = finalState.messages.find((m) => m.id === abortedAssistantId)!;
		expect(aborted.status).toBe('complete');
		// The persisted parts must reflect the abort, not the late-arriving
		// `remember` result that resolved after the user clicked stop.
		const abortedToolResult = (aborted.parts ?? []).find(
			(p): p is import('$lib/types/conversation').ToolResultPart => p.type === 'tool_result' && p.toolUseId === 't1',
		);
		expect(abortedToolResult).toBeTruthy();
		expect(abortedToolResult!.content).toBe('Aborted by user before this tool completed.');
		expect(abortedToolResult!.isError).toBe(true);
		expect(abortedToolResult!.streaming).toBeUndefined();

		// Cleanup the memories `remember` may have written.
		await env.DB.prepare('DELETE FROM memories').run();
	});
});
