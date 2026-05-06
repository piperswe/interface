import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
	bumpScheduleNow,
	computeNextRunAt,
	createSchedule,
	deleteSchedule,
	listDueSchedules,
	listSchedules,
	markScheduleRun,
	nextScheduledRun,
	setScheduleEnabled,
} from './schedules';

// Anchor: Monday 2026-05-04 12:34 UTC (a recognisable mid-week mid-day time).
const MONDAY_NOON = Date.UTC(2026, 4, 4, 12, 34, 0);

describe('computeNextRunAt', () => {
	it('hourly: rolls forward to the top of the next hour', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'hourly', null, null);
		expect(new Date(next).toISOString()).toBe('2026-05-04T13:00:00.000Z');
	});

	it('hourly: even when called exactly on the hour, advances to the next hour', () => {
		// Regression candidate: exactly-on-the-hour shouldn't return the same
		// instant (which would cause an immediate re-fire).
		const onTheHour = Date.UTC(2026, 4, 4, 13, 0, 0);
		const next = computeNextRunAt(onTheHour, 'hourly', null, null);
		expect(new Date(next).toISOString()).toBe('2026-05-04T14:00:00.000Z');
		expect(next).toBeGreaterThan(onTheHour);
	});

	it('hourly: ignores timeOfDay (always top of next hour)', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'hourly', 30, null);
		expect(new Date(next).toISOString()).toBe('2026-05-04T13:00:00.000Z');
	});

	it('hourly: rolls into the next day at 23:xx', () => {
		const lateNight = Date.UTC(2026, 4, 4, 23, 30, 0);
		const next = computeNextRunAt(lateNight, 'hourly', null, null);
		expect(new Date(next).toISOString()).toBe('2026-05-05T00:00:00.000Z');
	});

	it('daily: same day if the time of day is still ahead', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'daily', 18 * 60, null);
		expect(new Date(next).toISOString()).toBe('2026-05-04T18:00:00.000Z');
	});

	it('daily: next day if the time of day already passed', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'daily', 8 * 60, null);
		expect(new Date(next).toISOString()).toBe('2026-05-05T08:00:00.000Z');
	});

	it('daily: timeOfDay null defaults to UTC midnight', () => {
		// `from` is at noon, midnight has already passed → next midnight.
		const next = computeNextRunAt(MONDAY_NOON, 'daily', null, null);
		expect(new Date(next).toISOString()).toBe('2026-05-05T00:00:00.000Z');
	});

	it('daily: timeOfDay split into hours and minutes', () => {
		// 9*60 + 15 = 555 minutes → 09:15 UTC.
		const next = computeNextRunAt(MONDAY_NOON, 'daily', 9 * 60 + 15, null);
		// 09:15 has already passed at 12:34 → tomorrow at 09:15.
		expect(new Date(next).toISOString()).toBe('2026-05-05T09:15:00.000Z');
	});

	it('daily: when from === today\'s scheduled time, advances by one day', () => {
		const exactly = Date.UTC(2026, 4, 4, 9, 15, 0);
		const next = computeNextRunAt(exactly, 'daily', 9 * 60 + 15, null);
		// Same instant means today.getTime() === from, the > check is false,
		// so we advance to tomorrow.
		expect(new Date(next).toISOString()).toBe('2026-05-05T09:15:00.000Z');
	});

	it('weekly: same day later if the matching weekday hasn\'t reached its time yet', () => {
		// Monday is dayOfWeek=1. 18:00 UTC is later than 12:34 UTC.
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 18 * 60, 1);
		expect(new Date(next).toISOString()).toBe('2026-05-04T18:00:00.000Z');
	});

	it('weekly: rolls a full week forward if both day and time already passed', () => {
		// Monday earlier in the day → next Monday.
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 8 * 60, 1);
		expect(new Date(next).toISOString()).toBe('2026-05-11T08:00:00.000Z');
	});

	it('weekly: rolls forward to a later weekday', () => {
		// Friday = 5
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 9 * 60, 5);
		expect(new Date(next).toISOString()).toBe('2026-05-08T09:00:00.000Z');
	});

	it('weekly: wraps Sunday correctly', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 9 * 60, 0);
		expect(new Date(next).toISOString()).toBe('2026-05-10T09:00:00.000Z');
	});

	it('weekly: dayOfWeek null is treated as Sunday', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 9 * 60, null);
		// Sunday = 0; from is Monday → next Sunday.
		expect(new Date(next).toISOString()).toBe('2026-05-10T09:00:00.000Z');
	});

	it('weekly: negative dayOfWeek is normalised modulo 7', () => {
		// -6 % 7 = -6 in JS, then (-6 + 7) % 7 = 1 (Monday).
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 18 * 60, -6);
		expect(new Date(next).toISOString()).toBe('2026-05-04T18:00:00.000Z');
	});

	it('weekly: dayOfWeek out of range wraps via modulo', () => {
		// 8 mod 7 = 1 (Monday) — same as dayOfWeek=1.
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 18 * 60, 8);
		expect(new Date(next).toISOString()).toBe('2026-05-04T18:00:00.000Z');
	});
});

afterEach(async () => {
	await env.DB.prepare('DELETE FROM schedules').run();
});

describe('createSchedule + listSchedules', () => {
	const baseInput = {
		name: 'Daily standup',
		prompt: 'Summarise yesterday',
		recurrence: 'daily' as const,
		timeOfDay: 9 * 60,
		dayOfWeek: null,
		targetConversationId: null,
	};

	it('createSchedule returns the inserted row with computed nextRunAt', async () => {
		const row = await createSchedule(env, baseInput);
		expect(row.id).toBeGreaterThan(0);
		expect(row.name).toBe('Daily standup');
		expect(row.prompt).toBe('Summarise yesterday');
		expect(row.recurrence).toBe('daily');
		expect(row.timeOfDay).toBe(9 * 60);
		expect(row.dayOfWeek).toBeNull();
		expect(row.targetConversationId).toBeNull();
		expect(row.enabled).toBe(true);
		expect(row.lastRunAt).toBeNull();
		expect(row.nextRunAt).toBeGreaterThan(0);
		expect(row.createdAt).toBeGreaterThan(0);
		expect(row.updatedAt).toBe(row.createdAt);
	});

	it('listSchedules returns rows sorted by name', async () => {
		await createSchedule(env, { ...baseInput, name: 'b' });
		await createSchedule(env, { ...baseInput, name: 'a' });
		const rows = await listSchedules(env);
		expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
	});

	it('rejects empty name and prompt', async () => {
		await expect(createSchedule(env, { ...baseInput, name: '   ' })).rejects.toThrow(/Name/);
		await expect(createSchedule(env, { ...baseInput, prompt: '   ' })).rejects.toThrow(/Prompt/);
	});

	it('trims the name (but not the prompt)', async () => {
		const row = await createSchedule(env, {
			...baseInput,
			name: '  spacey  ',
			prompt: '  with spaces  ',
		});
		expect(row.name).toBe('spacey');
		// Prompt is preserved verbatim (the operator may want indentation).
		expect(row.prompt).toBe('  with spaces  ');
	});

	it('isolates rows per user_id', async () => {
		await createSchedule(env, { ...baseInput, name: 'u1-a' }, 1);
		await createSchedule(env, { ...baseInput, name: 'u2-a' }, 2);
		expect((await listSchedules(env, 1)).map((r) => r.name)).toEqual(['u1-a']);
		expect((await listSchedules(env, 2)).map((r) => r.name)).toEqual(['u2-a']);
	});

	it('persists targetConversationId verbatim', async () => {
		const row = await createSchedule(env, {
			...baseInput,
			targetConversationId: '00000000-0000-4000-8000-000000000000',
		});
		const reloaded = (await listSchedules(env)).find((r) => r.id === row.id);
		expect(reloaded?.targetConversationId).toBe('00000000-0000-4000-8000-000000000000');
	});

	it('hourly schedule has nextRunAt at the top of the next hour relative to insert', async () => {
		const before = Date.now();
		const row = await createSchedule(env, { ...baseInput, recurrence: 'hourly' });
		// Within one hour from "now": guard against clock surprises.
		expect(row.nextRunAt).toBeGreaterThan(before);
		expect(row.nextRunAt - before).toBeLessThanOrEqual(60 * 60 * 1000 + 1);
		// The minute and second components are zero (top of the hour).
		const d = new Date(row.nextRunAt);
		expect(d.getUTCMinutes()).toBe(0);
		expect(d.getUTCSeconds()).toBe(0);
		expect(d.getUTCMilliseconds()).toBe(0);
	});
});

describe('listDueSchedules', () => {
	it('returns only enabled schedules with next_run_at <= cutoff, ordered by next_run_at ASC', async () => {
		const row1 = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'hourly', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		});
		const row2 = await createSchedule(env, {
			name: 'B', prompt: 'b', recurrence: 'hourly', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		});
		const row3 = await createSchedule(env, {
			name: 'C', prompt: 'c', recurrence: 'hourly', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		});
		// Manually backdate row1 and row3 so they are due; tweak row1 < row3 for ordering.
		await env.DB.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').bind(1, row1.id).run();
		await env.DB.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').bind(2, row3.id).run();
		// Disable row3.
		await setScheduleEnabled(env, row3.id, false);
		// row2 stays at its computed (future) nextRunAt and should NOT be due.

		const due = await listDueSchedules(env, 1000);
		expect(due.map((r) => r.id)).toEqual([row1.id]);

		// With a cutoff that includes row3, but row3 is disabled — still only row1.
		const due2 = await listDueSchedules(env, 10);
		expect(due2.map((r) => r.id)).toEqual([row1.id]);

		// Re-enabling row3 surfaces it AFTER row1 (1 < 2).
		await setScheduleEnabled(env, row3.id, true);
		const due3 = await listDueSchedules(env, 10);
		expect(due3.map((r) => r.id)).toEqual([row1.id, row3.id]);

		// Suppress unused row2 warning.
		void row2;
	});
});

describe('nextScheduledRun', () => {
	it('returns null when there are no enabled schedules', async () => {
		expect(await nextScheduledRun(env)).toBeNull();
		const row = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'hourly', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		});
		await setScheduleEnabled(env, row.id, false);
		expect(await nextScheduledRun(env)).toBeNull();
	});

	it('returns the minimum next_run_at across enabled schedules', async () => {
		const a = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'hourly', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		});
		const b = await createSchedule(env, {
			name: 'B', prompt: 'b', recurrence: 'hourly', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		});
		await env.DB.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').bind(100, a.id).run();
		await env.DB.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').bind(50, b.id).run();
		expect(await nextScheduledRun(env)).toBe(50);
		// Disabling the smaller one falls back to the next.
		await setScheduleEnabled(env, b.id, false);
		expect(await nextScheduledRun(env)).toBe(100);
	});
});

describe('markScheduleRun', () => {
	it('records last_run_at and recomputes next_run_at off (runAt + 1)', async () => {
		const row = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'daily', timeOfDay: 9 * 60, dayOfWeek: null, targetConversationId: null,
		});
		const runAt = MONDAY_NOON;
		await markScheduleRun(env, row.id, runAt);
		const after = (await listSchedules(env)).find((r) => r.id === row.id)!;
		expect(after.lastRunAt).toBe(runAt);
		// daily 09:00 with from=12:34:00.001 → tomorrow 09:00.
		expect(new Date(after.nextRunAt).toISOString()).toBe('2026-05-05T09:00:00.000Z');
	});

	it('is a no-op when the id does not exist', async () => {
		await markScheduleRun(env, 999_999, 123);
		// Nothing to assert directly other than the call resolving without throwing.
	});

	it('handles weekly recurrence when re-computing nextRunAt', async () => {
		const row = await createSchedule(env, {
			name: 'W', prompt: 'a', recurrence: 'weekly', timeOfDay: 8 * 60, dayOfWeek: 1, targetConversationId: null,
		});
		// Force a known runAt: Mon 2026-05-04 08:00 UTC.
		const runAt = Date.UTC(2026, 4, 4, 8, 0, 0);
		await markScheduleRun(env, row.id, runAt);
		const after = (await listSchedules(env)).find((r) => r.id === row.id)!;
		// runAt+1ms, weekly Monday 08:00 → next Monday.
		expect(new Date(after.nextRunAt).toISOString()).toBe('2026-05-11T08:00:00.000Z');
	});
});

describe('bumpScheduleNow', () => {
	it('sets next_run_at to "now" and re-enables the schedule', async () => {
		const row = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'hourly', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		});
		await setScheduleEnabled(env, row.id, false);
		const before = Date.now();
		await bumpScheduleNow(env, row.id);
		const after = (await listSchedules(env)).find((r) => r.id === row.id)!;
		expect(after.enabled).toBe(true);
		expect(after.nextRunAt).toBeGreaterThanOrEqual(before);
		// Should be due immediately.
		const due = await listDueSchedules(env, Date.now() + 1);
		expect(due.map((r) => r.id)).toContain(row.id);
	});

	it('is scoped by user_id', async () => {
		const row = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'hourly', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		}, 1);
		const beforeNext = (await listSchedules(env, 1)).find((r) => r.id === row.id)!.nextRunAt;
		// Wrong user — shouldn't change anything.
		await bumpScheduleNow(env, row.id, 2);
		const after = (await listSchedules(env, 1)).find((r) => r.id === row.id)!;
		expect(after.nextRunAt).toBe(beforeNext);
	});
});

describe('setScheduleEnabled / deleteSchedule', () => {
	it('setScheduleEnabled toggles enabled and bumps updated_at', async () => {
		const row = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'daily', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		});
		expect(row.enabled).toBe(true);
		await setScheduleEnabled(env, row.id, false);
		const off = (await listSchedules(env)).find((r) => r.id === row.id)!;
		expect(off.enabled).toBe(false);
		expect(off.updatedAt).toBeGreaterThanOrEqual(row.updatedAt);
		await setScheduleEnabled(env, row.id, true);
		const on = (await listSchedules(env)).find((r) => r.id === row.id)!;
		expect(on.enabled).toBe(true);
	});

	it('setScheduleEnabled is scoped by user_id', async () => {
		const row = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'daily', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		}, 1);
		await setScheduleEnabled(env, row.id, false, 2); // wrong user
		expect((await listSchedules(env, 1)).find((r) => r.id === row.id)!.enabled).toBe(true);
	});

	it('deleteSchedule removes the row and is scoped by user_id', async () => {
		const row = await createSchedule(env, {
			name: 'A', prompt: 'a', recurrence: 'daily', timeOfDay: null, dayOfWeek: null, targetConversationId: null,
		}, 1);
		// Wrong user — no effect.
		await deleteSchedule(env, row.id, 2);
		expect((await listSchedules(env, 1))).toHaveLength(1);
		await deleteSchedule(env, row.id, 1);
		expect(await listSchedules(env, 1)).toHaveLength(0);
	});
});
