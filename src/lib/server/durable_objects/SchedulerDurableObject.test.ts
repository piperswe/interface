import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createSchedule,
	listSchedules,
	nextScheduledRun,
	type Schedule,
} from '../schedules';
import { setSetting } from '../settings';
import { createProvider } from '../providers/store';
import { createModel } from '../providers/models';
import { getSchedulerStub, getConversationStub } from './index';
import { textTurn } from '../../../../test/fakes/FakeLLM';
import { setOverride, readState, waitForState } from './conversation/_test-helpers';
import type SchedulerDurableObject from './SchedulerDurableObject';

afterEach(async () => {
	const stub = getSchedulerStub(env);
	await runInDurableObject(stub, async (_, ctx) => {
		await ctx.storage.deleteAlarm();
	});
	await env.DB.prepare('DELETE FROM schedules').run();
	await env.DB.prepare('DELETE FROM conversations').run();
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
	await env.DB.prepare('DELETE FROM settings').run();
});

async function readAlarm(): Promise<number | null> {
	const stub = getSchedulerStub(env);
	return runInDurableObject(stub, async (_, ctx) => ctx.storage.getAlarm());
}

async function fireAlarm(): Promise<void> {
	const stub = getSchedulerStub(env);
	await runInDurableObject(stub, async (instance) => {
		await (instance as SchedulerDurableObject).alarm();
	});
}

async function bump(): Promise<void> {
	const stub = getSchedulerStub(env);
	await runInDurableObject(stub, async (instance) => {
		await (instance as SchedulerDurableObject).bump();
	});
}

async function seedFakeModel(modelGlobalId = 'fake/model'): Promise<void> {
	await createProvider(env, { id: 'fake', type: 'openai_compatible', apiKey: 'k' });
	await createModel(env, 'fake', { id: 'model', name: 'Fake Model' });
	await setSetting(env, 'default_model', modelGlobalId);
}

beforeEach(async () => {
	// Defensive: clear alarm so previous-test residue doesn't fire mid-run.
	await runInDurableObject(getSchedulerStub(env), async (_, ctx) => {
		await ctx.storage.deleteAlarm();
	});
});

describe('SchedulerDurableObject — bump()', () => {
	it('sets an alarm at the next scheduled run', async () => {
		const scheduled = await createSchedule(env, {
			name: 's',
			prompt: 'p',
			recurrence: 'daily',
			timeOfDay: 8 * 60,
			dayOfWeek: null,
			targetConversationId: null,
		});
		await bump();
		const alarm = await readAlarm();
		// The exact time depends on `now`; verify it tracks nextScheduledRun.
		const expected = await nextScheduledRun(env);
		expect(alarm).not.toBeNull();
		expect(expected).toBe(scheduled.nextRunAt);
		// The alarm clamps to at least now+1s; the scheduled time may be in the
		// future, but the alarm should be near it.
		expect(alarm).toBeGreaterThanOrEqual(Date.now());
	});

	it('clears the alarm when no enabled schedules exist', async () => {
		await createSchedule(env, {
			name: 's',
			prompt: 'p',
			recurrence: 'daily',
			timeOfDay: 8 * 60,
			dayOfWeek: null,
			targetConversationId: null,
		});
		await bump();
		expect(await readAlarm()).not.toBeNull();
		// Disable / delete the schedule, then bump again.
		await env.DB.prepare('UPDATE schedules SET enabled = 0').run();
		await bump();
		expect(await readAlarm()).toBeNull();
	});

	it('clamps the alarm to within MAX_ALARM_HORIZON_MS', async () => {
		// Set next_run_at three days in the future.
		const future = Date.now() + 3 * 24 * 60 * 60 * 1000;
		await createSchedule(env, {
			name: 'far',
			prompt: 'p',
			recurrence: 'daily',
			timeOfDay: 0,
			dayOfWeek: null,
			targetConversationId: null,
		});
		await env.DB.prepare('UPDATE schedules SET next_run_at = ?').bind(future).run();
		await bump();
		const alarm = await readAlarm();
		expect(alarm).not.toBeNull();
		// Should be within 24h+slop of now.
		expect(alarm!).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 5_000);
	});
});

describe('SchedulerDurableObject — alarm()', () => {
	async function dueSchedule(input: Partial<Parameters<typeof createSchedule>[1]> = {}): Promise<Schedule> {
		const created = await createSchedule(env, {
			name: 'morning',
			prompt: 'check on overnight emails',
			recurrence: 'daily',
			timeOfDay: 0,
			dayOfWeek: null,
			targetConversationId: null,
			...input,
		});
		// Force it overdue.
		await env.DB.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?')
			.bind(Date.now() - 60_000, created.id)
			.run();
		return created;
	}

	it('runs a due schedule by posting the prompt as a user message into a fresh conversation', async () => {
		await seedFakeModel();
		const created = await dueSchedule();
		await fireAlarm();
		// A new conversation should now exist.
		const conversations = await env.DB.prepare('SELECT id FROM conversations')
			.all<{ id: string }>();
		expect(conversations.results?.length).toBe(1);
		const convoId = conversations.results![0].id;
		// User message is queued (assistant generation is in-flight against the
		// real router; we don't stub that here because the schedule path doesn't
		// require deterministic completion). Just check the user message landed.
		const stub = getConversationStub(env, convoId);
		await waitForState(
			stub,
			(s) => s.messages.some((m) => m.role === 'user' && m.content === created.prompt),
			{ timeoutMs: 5000 },
		);
		// next_run_at should have advanced.
		const list = await listSchedules(env);
		expect(list[0].lastRunAt).not.toBeNull();
		expect(list[0].nextRunAt).toBeGreaterThan(Date.now());
	});

	it('uses target_conversation_id when set, posting into that conversation', async () => {
		await seedFakeModel();
		// Pre-create the target conversation and override its LLM so the
		// generation completes deterministically.
		const targetId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'pinned', ?, ?)",
		)
			.bind(targetId, Date.now(), Date.now())
			.run();
		const targetStub = getConversationStub(env, targetId);
		await setOverride(targetStub, [textTurn('ok').events]);

		await dueSchedule({ targetConversationId: targetId });
		await fireAlarm();

		const state = await waitForState(
			targetStub,
			(s) => s.messages.some((m) => m.role === 'assistant' && m.status === 'complete'),
			{ timeoutMs: 5000 },
		);
		const userMsg = state.messages.find((m) => m.role === 'user');
		expect(userMsg?.content).toBe('check on overnight emails');
		expect(state.messages.find((m) => m.role === 'assistant')?.content).toBe('ok');
	});

	it('skips a schedule when no models are configured (warns, no message posted)', async () => {
		// Don't seed a model. The DO will still create the placeholder
		// conversation row before checking models, so we assert that no user
		// message was posted into it instead.
		await dueSchedule();
		await fireAlarm();
		const conversations = await env.DB.prepare('SELECT id FROM conversations')
			.all<{ id: string }>();
		// The conversation row is created up-front; its DO should be empty.
		if (conversations.results && conversations.results.length > 0) {
			const stub = getConversationStub(env, conversations.results[0].id);
			const state = await readState(stub);
			expect(state.messages).toEqual([]);
		}
		// Schedule still advances (markScheduleRun fired in the finally block).
		const list = await listSchedules(env);
		expect(list[0].lastRunAt).not.toBeNull();
	});

	it('falls through silently when the target DO is busy', async () => {
		await seedFakeModel();
		const targetId = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, 'busy', ?, ?)",
		)
			.bind(targetId, Date.now(), Date.now())
			.run();
		const targetStub = getConversationStub(env, targetId);
		// Override LLM with a turn that emits a single text_delta but never
		// signals `done` — the DO stays in `inProgress`, so the next
		// addUserMessage hits the `busy` branch.
		await setOverride(targetStub, [
			[{ type: 'text_delta', delta: 'partial' }],
		]);

		await dueSchedule({ targetConversationId: targetId });
		await fireAlarm();
		// First fire kicks off generation. Now manually mark the schedule due
		// again and fire — the second post should hit `busy` and the schedule
		// should still advance.
		await env.DB.prepare('UPDATE schedules SET next_run_at = ?')
			.bind(Date.now() - 60_000)
			.run();
		// The second alarm should not throw even though the conversation is busy.
		await expect(fireAlarm()).resolves.toBeUndefined();
		const list = await listSchedules(env);
		expect(list[0].lastRunAt).not.toBeNull();
	});

	it('re-arms an alarm for the next due schedule after running', async () => {
		await seedFakeModel();
		await dueSchedule();
		await fireAlarm();
		// After running a daily schedule, the next alarm should be set to the
		// next day's run time.
		const alarm = await readAlarm();
		expect(alarm).not.toBeNull();
		expect(alarm!).toBeGreaterThan(Date.now());
	});
});
