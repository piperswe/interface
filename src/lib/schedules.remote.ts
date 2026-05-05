import { form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import {
	bumpScheduleNow,
	createSchedule,
	deleteSchedule,
	setScheduleEnabled,
	type Recurrence,
} from '$lib/server/schedules';
import { getSchedulerStub } from '$lib/server/durable_objects';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

function parseTimeOfDay(raw: string): number | null {
	const m = raw.match(/^(\d{2}):(\d{2})$/);
	if (!m) return null;
	const hh = Number.parseInt(m[1], 10);
	const mm = Number.parseInt(m[2], 10);
	if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
	return hh * 60 + mm;
}

function parseRecurrence(raw: string): Recurrence | null {
	if (raw === 'hourly' || raw === 'daily' || raw === 'weekly') return raw;
	return null;
}

async function bumpScheduler(env: Env): Promise<void> {
	try {
		await getSchedulerStub(env).bump();
	} catch (e) {
		// Binding not configured — surface but don't block CRUD.
		console.warn('scheduler bump failed', e);
	}
}

export const addSchedule = form(
	'unchecked',
	async (data: {
		name?: unknown;
		prompt?: unknown;
		recurrence?: unknown;
		time_of_day?: unknown;
		day_of_week?: unknown;
		target_conversation_id?: unknown;
	}) => {
		const env = getEnv();
		const name = String(data.name ?? '').trim();
		const prompt = String(data.prompt ?? '').trim();
		const recurrence = parseRecurrence(String(data.recurrence ?? ''));
		const targetRaw = String(data.target_conversation_id ?? '').trim();
		if (!name) error(400, 'Name is required');
		if (!prompt) error(400, 'Prompt is required');
		if (!recurrence) error(400, 'Recurrence must be hourly, daily, or weekly');
		const tod = parseTimeOfDay(String(data.time_of_day ?? ''));
		const dow = Number.parseInt(String(data.day_of_week ?? ''), 10);
		const targetId = targetRaw && CONVERSATION_ID_PATTERN.test(targetRaw) ? targetRaw : null;
		try {
			await createSchedule(env, {
				name,
				prompt,
				recurrence,
				timeOfDay: recurrence === 'hourly' ? null : tod ?? 8 * 60,
				dayOfWeek: recurrence === 'weekly' ? (Number.isFinite(dow) ? ((dow + 7) % 7) : 1) : null,
				targetConversationId: targetId,
			});
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		await bumpScheduler(env);
		redirect(303, '/settings');
	},
);

export const removeSchedule = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	const env = getEnv();
	await deleteSchedule(env, id);
	await bumpScheduler(env);
	redirect(303, '/settings');
});

export const toggleSchedule = form('unchecked', async (data: { id?: unknown; enabled?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	const enabled = String(data.enabled ?? '') === 'true';
	const env = getEnv();
	await setScheduleEnabled(env, id, enabled);
	await bumpScheduler(env);
	redirect(303, '/settings');
});

export const runScheduleNow = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	const env = getEnv();
	await bumpScheduleNow(env, id);
	await bumpScheduler(env);
	redirect(303, '/settings');
});
