// Recurring scheduled prompts. Persisted in D1; the SchedulerDurableObject
// scans this table on alarm fire and runs each due schedule by posting the
// `prompt` as a user message into `target_conversation_id` (or a fresh
// conversation when null).

import { now as nowMs } from './clock';

const SINGLE_USER_ID = 1;

export type Recurrence = 'hourly' | 'daily' | 'weekly';

export type Schedule = {
	id: number;
	name: string;
	prompt: string;
	recurrence: Recurrence;
	timeOfDay: number | null;
	dayOfWeek: number | null;
	targetConversationId: string | null;
	enabled: boolean;
	nextRunAt: number;
	lastRunAt: number | null;
	createdAt: number;
	updatedAt: number;
};

type ScheduleRow = {
	id: number;
	name: string;
	prompt: string;
	recurrence: string;
	time_of_day: number | null;
	day_of_week: number | null;
	target_conversation_id: string | null;
	enabled: number;
	next_run_at: number;
	last_run_at: number | null;
	created_at: number;
	updated_at: number;
};

function rowToSchedule(r: ScheduleRow): Schedule {
	return {
		createdAt: r.created_at,
		dayOfWeek: r.day_of_week,
		enabled: !!r.enabled,
		id: r.id,
		lastRunAt: r.last_run_at,
		name: r.name,
		nextRunAt: r.next_run_at,
		prompt: r.prompt,
		recurrence: r.recurrence === 'hourly' || r.recurrence === 'weekly' ? r.recurrence : 'daily',
		targetConversationId: r.target_conversation_id,
		timeOfDay: r.time_of_day,
		updatedAt: r.updated_at,
	};
}

// Compute the next fire timestamp (ms) at or after `from` for a given
// recurrence.  Times are UTC: `timeOfDay` is minutes from midnight UTC,
// `dayOfWeek` is 0=Sunday.
//
//   hourly:  next minute mark of the hour matching `timeOfDay % 60`
//            (or simply `from` rounded up to the next hour boundary).
//   daily:   next UTC midnight + timeOfDay minutes.
//   weekly:  next occurrence of the matching weekday at timeOfDay UTC.
//
// Pure / deterministic so it can be unit tested.
export function computeNextRunAt(from: number, recurrence: Recurrence, timeOfDay: number | null, dayOfWeek: number | null): number {
	const fromDate = new Date(from);
	if (recurrence === 'hourly') {
		const next = new Date(
			Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate(), fromDate.getUTCHours() + 1, 0, 0, 0),
		);
		return next.getTime();
	}
	const minutes = timeOfDay ?? 0;
	const hh = Math.floor(minutes / 60);
	const mm = minutes % 60;
	const today = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate(), hh, mm, 0, 0));
	if (recurrence === 'daily') {
		if (today.getTime() > from) return today.getTime();
		return today.getTime() + 24 * 60 * 60 * 1000;
	}
	// weekly
	const target = ((dayOfWeek ?? 0) + 7) % 7;
	const currentDow = today.getUTCDay();
	let daysAhead = (target - currentDow + 7) % 7;
	if (daysAhead === 0 && today.getTime() <= from) daysAhead = 7;
	return today.getTime() + daysAhead * 24 * 60 * 60 * 1000;
}

export async function listSchedules(env: Env, userId: number = SINGLE_USER_ID): Promise<Schedule[]> {
	const result = await env.DB.prepare(
		`SELECT id, name, prompt, recurrence, time_of_day, day_of_week,
		        target_conversation_id, enabled, next_run_at, last_run_at,
		        created_at, updated_at
		   FROM schedules WHERE user_id = ? ORDER BY name`,
	)
		.bind(userId)
		.all<ScheduleRow>();
	return (result.results ?? []).map(rowToSchedule);
}

export async function listDueSchedules(env: Env, before: number): Promise<Schedule[]> {
	const result = await env.DB.prepare(
		`SELECT id, name, prompt, recurrence, time_of_day, day_of_week,
		        target_conversation_id, enabled, next_run_at, last_run_at,
		        created_at, updated_at
		   FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC`,
	)
		.bind(before)
		.all<ScheduleRow>();
	return (result.results ?? []).map(rowToSchedule);
}

export async function nextScheduledRun(env: Env): Promise<number | null> {
	const row = await env.DB.prepare(`SELECT MIN(next_run_at) AS next FROM schedules WHERE enabled = 1`).first<{ next: number | null }>();
	return row?.next ?? null;
}

export type CreateScheduleInput = {
	name: string;
	prompt: string;
	recurrence: Recurrence;
	timeOfDay: number | null;
	dayOfWeek: number | null;
	targetConversationId: string | null;
};

export async function createSchedule(env: Env, input: CreateScheduleInput, userId: number = SINGLE_USER_ID): Promise<Schedule> {
	if (!input.name.trim()) throw new Error('Name is required');
	if (!input.prompt.trim()) throw new Error('Prompt is required');
	const now = nowMs();
	const next = computeNextRunAt(now, input.recurrence, input.timeOfDay, input.dayOfWeek);
	const result = await env.DB.prepare(
		`INSERT INTO schedules (user_id, name, prompt, recurrence, time_of_day, day_of_week,
		                        target_conversation_id, enabled, next_run_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
		 RETURNING id`,
	)
		.bind(
			userId,
			input.name.trim(),
			input.prompt,
			input.recurrence,
			input.timeOfDay,
			input.dayOfWeek,
			input.targetConversationId,
			next,
			now,
			now,
		)
		.first<{ id: number }>();
	const id = result?.id ?? 0;
	return {
		createdAt: now,
		dayOfWeek: input.dayOfWeek,
		enabled: true,
		id,
		lastRunAt: null,
		name: input.name.trim(),
		nextRunAt: next,
		prompt: input.prompt,
		recurrence: input.recurrence,
		targetConversationId: input.targetConversationId,
		timeOfDay: input.timeOfDay,
		updatedAt: now,
	};
}

export async function deleteSchedule(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM schedules WHERE id = ? AND user_id = ?').bind(id, userId).run();
}

export async function setScheduleEnabled(env: Env, id: number, enabled: boolean, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare(`UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
		.bind(enabled ? 1 : 0, nowMs(), id, userId)
		.run();
}

// Mark a schedule as having just fired and recompute next_run_at. `runAt`
// is the moment we ran it; the next time is computed off `runAt + 1ms` so
// "daily" / "weekly" don't immediately re-match.
export async function markScheduleRun(env: Env, id: number, runAt: number): Promise<void> {
	const row = await env.DB.prepare(`SELECT recurrence, time_of_day, day_of_week FROM schedules WHERE id = ?`)
		.bind(id)
		.first<{ recurrence: string; time_of_day: number | null; day_of_week: number | null }>();
	if (!row) return;
	const rec: Recurrence = row.recurrence === 'hourly' || row.recurrence === 'weekly' ? row.recurrence : 'daily';
	const next = computeNextRunAt(runAt + 1, rec, row.time_of_day, row.day_of_week);
	await env.DB.prepare(`UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
		.bind(runAt, next, nowMs(), id)
		.run();
}

// Force a schedule to run on the next alarm tick (sets next_run_at to now).
export async function bumpScheduleNow(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare(`UPDATE schedules SET next_run_at = ?, enabled = 1, updated_at = ? WHERE id = ? AND user_id = ?`)
		.bind(nowMs(), nowMs(), id, userId)
		.run();
}
