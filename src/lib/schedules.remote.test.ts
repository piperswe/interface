import { env, runInDurableObject } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import * as remote from './schedules.remote';
import { listSchedules } from './server/schedules';
import { getSchedulerStub } from './server/durable_objects';

type AnyArgs = (...args: unknown[]) => Promise<unknown>;
const addSchedule = remote.addSchedule as unknown as AnyArgs;
const removeSchedule = remote.removeSchedule as unknown as AnyArgs;
const toggleSchedule = remote.toggleSchedule as unknown as AnyArgs;
const runScheduleNow = remote.runScheduleNow as unknown as AnyArgs;

beforeEach(() => {
	setMockRequestEvent({ platform: { env } });
});

afterEach(async () => {
	clearMockRequestEvent();
	await env.DB.prepare('DELETE FROM schedules').run();
	await env.DB.prepare('DELETE FROM conversations').run();
	// Clear the scheduler DO's alarm so a previous test's bump doesn't bleed
	// into the next.
	const stub = getSchedulerStub(env);
	await runInDurableObject(stub, async (_, ctx) => {
		await ctx.storage.deleteAlarm();
	});
});

async function expectRedirect(promise: Promise<unknown>, locationStartsWith: string) {
	try {
		await promise;
		throw new Error('expected redirect');
	} catch (e) {
		if (!isRedirect(e)) throw e;
		expect(e.location.startsWith(locationStartsWith)).toBe(true);
	}
}

async function expectError(promise: Promise<unknown>, status: number, msg?: RegExp) {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
		if (msg) expect(String(e.body.message)).toMatch(msg);
	}
}

async function runForm(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch (e) {
		if (!isRedirect(e)) throw e;
	}
}

async function readSchedulerAlarm(): Promise<number | null> {
	const stub = getSchedulerStub(env);
	return runInDurableObject(stub, async (_, ctx) => ctx.storage.getAlarm());
}

describe('schedules.remote — addSchedule', () => {
	it('persists a daily schedule and bumps the scheduler alarm', async () => {
		await expectRedirect(
			addSchedule({
				name: 'morning brief',
				prompt: 'Summarise overnight emails.',
				recurrence: 'daily',
				time_of_day: '08:00',
			}) as Promise<unknown>,
			'/settings',
		);
		const list = await listSchedules(env);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			name: 'morning brief',
			prompt: 'Summarise overnight emails.',
			recurrence: 'daily',
			timeOfDay: 8 * 60,
			enabled: true,
		});
		// nextRunAt is set to the next 08:00 UTC.
		expect(list[0].nextRunAt).toBeGreaterThan(0);
		// The scheduler DO's alarm should have been set by the bump.
		const alarm = await readSchedulerAlarm();
		expect(alarm).not.toBeNull();
	});

	it('defaults daily time_of_day to 08:00 when unparseable', async () => {
		await expectRedirect(
			addSchedule({
				name: 'no-time',
				prompt: 'whatever',
				recurrence: 'daily',
				time_of_day: 'garbage',
			}) as Promise<unknown>,
			'/settings',
		);
		const list = await listSchedules(env);
		expect(list[0].timeOfDay).toBe(8 * 60);
	});

	it('weekly schedule defaults day_of_week to Monday (1) when unparseable', async () => {
		await expectRedirect(
			addSchedule({
				name: 'weekly',
				prompt: 'check in',
				recurrence: 'weekly',
				time_of_day: '09:00',
				day_of_week: 'nope',
			}) as Promise<unknown>,
			'/settings',
		);
		const list = await listSchedules(env);
		expect(list[0].recurrence).toBe('weekly');
		expect(list[0].dayOfWeek).toBe(1);
	});

	it('hourly schedule sets time_of_day to null', async () => {
		await expectRedirect(
			addSchedule({
				name: 'hourly',
				prompt: 'tick',
				recurrence: 'hourly',
			}) as Promise<unknown>,
			'/settings',
		);
		const list = await listSchedules(env);
		expect(list[0].recurrence).toBe('hourly');
		expect(list[0].timeOfDay).toBeNull();
	});

	it('rejects empty name', async () => {
		await expectError(
			addSchedule({ name: '', prompt: 'p', recurrence: 'daily' }) as Promise<unknown>,
			400,
			/Name/,
		);
	});

	it('rejects empty prompt', async () => {
		await expectError(
			addSchedule({ name: 'n', prompt: '', recurrence: 'daily' }) as Promise<unknown>,
			400,
			/Prompt/,
		);
	});

	it('rejects unknown recurrence', async () => {
		await expectError(
			addSchedule({ name: 'n', prompt: 'p', recurrence: 'yearly' }) as Promise<unknown>,
			400,
			/Recurrence/,
		);
	});

	it('keeps target_conversation_id null when malformed', async () => {
		await expectRedirect(
			addSchedule({
				name: 'targeted',
				prompt: 'p',
				recurrence: 'daily',
				time_of_day: '08:00',
				target_conversation_id: 'not-a-uuid',
			}) as Promise<unknown>,
			'/settings',
		);
		const list = await listSchedules(env);
		expect(list[0].targetConversationId).toBeNull();
	});
});

describe('schedules.remote — removeSchedule', () => {
	it('deletes the row', async () => {
		await runForm(addSchedule({ name: 'gone', prompt: 'p', recurrence: 'daily', time_of_day: '08:00' }));
		const id = (await listSchedules(env))[0].id;
		await expectRedirect(removeSchedule({ id }) as Promise<unknown>, '/settings');
		expect(await listSchedules(env)).toEqual([]);
	});

	it('rejects an invalid id', async () => {
		await expectError(removeSchedule({ id: 'abc' }) as Promise<unknown>, 400);
	});
});

describe('schedules.remote — toggleSchedule', () => {
	it('disables an enabled schedule', async () => {
		await runForm(addSchedule({ name: 's', prompt: 'p', recurrence: 'daily', time_of_day: '08:00' }));
		const id = (await listSchedules(env))[0].id;
		await expectRedirect(toggleSchedule({ id, enabled: 'false' }) as Promise<unknown>, '/settings');
		const list = await listSchedules(env);
		expect(list[0].enabled).toBe(false);
	});

	it('re-enables a disabled schedule', async () => {
		await runForm(addSchedule({ name: 's', prompt: 'p', recurrence: 'daily', time_of_day: '08:00' }));
		const id = (await listSchedules(env))[0].id;
		await runForm(toggleSchedule({ id, enabled: 'false' }));
		await expectRedirect(toggleSchedule({ id, enabled: 'true' }) as Promise<unknown>, '/settings');
		const list = await listSchedules(env);
		expect(list[0].enabled).toBe(true);
	});

	it('rejects an invalid id', async () => {
		await expectError(toggleSchedule({ id: 0, enabled: 'true' }) as Promise<unknown>, 400);
	});
});

describe('schedules.remote — runScheduleNow', () => {
	it('sets next_run_at to roughly now', async () => {
		await runForm(
			addSchedule({
				name: 'soon',
				prompt: 'p',
				recurrence: 'daily',
				time_of_day: '08:00',
			}),
		);
		const id = (await listSchedules(env))[0].id;
		const before = Date.now();
		await expectRedirect(runScheduleNow({ id }) as Promise<unknown>, '/settings');
		const after = Date.now();
		const list = await listSchedules(env);
		expect(list[0].nextRunAt).toBeGreaterThanOrEqual(before - 1000);
		expect(list[0].nextRunAt).toBeLessThanOrEqual(after + 1000);
	});

	it('rejects an invalid id', async () => {
		await expectError(runScheduleNow({ id: -1 }) as Promise<unknown>, 400);
	});
});
