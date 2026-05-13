import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDefined } from '../../../../test/assert-defined';
import { textTurn, toolUseTurn } from '../../../../test/fakes/FakeLLM';
import { createConversation } from '../conversations';
import { setOverride, stubFor, waitForState } from './conversation/_test-helpers';
import type { ConversationStub } from './index';

type WithToolBarrier = {
	__armToolExecBarrier(): Promise<number>;
	__releaseToolExecBarrier(slot: number): Promise<void>;
};
const barrierFor = (stub: ConversationStub) => stub as unknown as WithToolBarrier;

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('ConversationDurableObject — alarm heartbeat', () => {
	// Regression: a DO can be evicted mid-generation when no live request is
	// holding it open. Cloudflare guarantees that a DO with a scheduled
	// alarm is not evicted before that alarm fires, so #generate now arms a
	// 30s heartbeat alarm at the start of work and refreshes it inside the
	// tool loop. When work ends, #endWork() must clear the alarm so the DO
	// can hibernate naturally.
	it('schedules a heartbeat alarm during work and clears it on completion', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await setOverride(stub, [toolUseTurn('t1', 'remember', { content: 'foo' }).events, textTurn('done').events]);

		const slot = await barrierFor(stub).__armToolExecBarrier();
		const started = await stub.addUserMessage(id, 'hi', 'fake/model');
		expect(started).toEqual({ status: 'started' });

		// Wait until #generate has parked at the tool barrier. By now
		// #beginWork() has run at the top of #generate.
		await waitForState(stub, (s) => {
			const last = s.messages.at(-1);
			return (last?.parts ?? []).some((p) => p.type === 'tool_result' && p.streaming === true);
		});

		const midAlarm = await runInDurableObject(stub, async (_inst, ctx) => ctx.storage.getAlarm());
		expect(midAlarm).not.toBeNull();
		assertDefined(midAlarm);
		// 30s heartbeat ± wall-clock noise. Just check it's in the future.
		expect(midAlarm).toBeGreaterThan(Date.now() - 1_000);

		await barrierFor(stub).__releaseToolExecBarrier(slot);
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');

		const finalAlarm = await runInDurableObject(stub, async (_inst, ctx) => ctx.storage.getAlarm());
		expect(finalAlarm).toBeNull();
	});

	// Regression: when alarm() fires while work is still in flight on the
	// same activation, it must reschedule the heartbeat (Branch A) rather
	// than fall through to #detectAndResume (Branch B). Otherwise the next
	// 30s window passes without any alarm and the DO becomes evictable
	// mid-stream — exactly the bug we're trying to prevent.
	it('alarm handler reschedules heartbeat while work is in flight', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await setOverride(stub, [toolUseTurn('t1', 'remember', { content: 'foo' }).events, textTurn('done').events]);

		const slot = await barrierFor(stub).__armToolExecBarrier();
		await stub.addUserMessage(id, 'hi', 'fake/model');

		await waitForState(stub, (s) => {
			const last = s.messages.at(-1);
			return (last?.parts ?? []).some((p) => p.type === 'tool_result' && p.streaming === true);
		});

		// Override the heartbeat alarm with a sentinel far in the future so
		// (a) workerd's natural scheduler can't auto-fire it before we do,
		// and (b) we can prove a reschedule happened by observing A2 is
		// orders of magnitude smaller than the sentinel.
		const sentinel = Date.now() + 5 * 60 * 1000;
		await runInDurableObject(stub, async (_inst, ctx) => {
			await ctx.storage.setAlarm(sentinel);
		});

		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		const a2 = await runInDurableObject(stub, async (_inst, ctx) => ctx.storage.getAlarm());
		expect(a2).not.toBeNull();
		assertDefined(a2);
		// Branch A re-arms the heartbeat to Date.now() + 30s. Branch B with
		// an active #inProgress is a no-op and leaves alarm == null. The
		// sentinel was 5min out, so a value well under 1min away proves the
		// heartbeat was re-scheduled rather than left as the sentinel.
		expect(a2).toBeLessThan(sentinel - 60_000);

		// And the streaming row was not touched by a resume — Branch B's
		// #detectAndResume rewrites started_at when it hydrates #inProgress.
		const status = await runInDurableObject(stub, async (_inst, ctx) => {
			const rows = ctx.storage.sql.exec("SELECT status FROM messages WHERE role = 'assistant'").toArray() as unknown as Array<{
				status: string;
			}>;
			return rows[0]?.status;
		});
		expect(status).toBe('streaming');

		await barrierFor(stub).__releaseToolExecBarrier(slot);
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');
	});

	// Regression: the new alarm() handler must still fall through to
	// #detectAndResume() when the DO activates fresh after eviction (in
	// memory: #heartbeatActive=false, #activeWorkCount=0). This mirrors
	// the existing resume.test.ts case to confirm the heartbeat changes
	// haven't broken the eviction-recovery backstop.
	it('eviction-recovery via alarm still resumes a streaming row', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_inst, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hi', NULL, 'complete', 1)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', '', 'fake/model', 'streaming', 2)",
			);
			ctx.storage.sql.exec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('conversation_id', ?)", id);
			await ctx.storage.setAlarm(Date.now() + 60_000);
		});
		await setOverride(stub, [textTurn('alarm-resumed').events]);

		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		const state = await waitForState(stub, (s) => s.messages.find((m) => m.id === 'a1')?.status === 'complete');
		expect(state.messages.find((m) => m.id === 'a1')?.content).toBe('alarm-resumed');
	});
});
