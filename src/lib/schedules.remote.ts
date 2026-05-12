import { form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import {
	bumpScheduleNow,
	createSchedule,
	deleteSchedule,
	setScheduleEnabled,
} from '$lib/server/schedules';
import { getSchedulerStub } from '$lib/server/durable_objects';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import { positiveIntFromString, trimmedNonEmpty } from '$lib/server/remote-schemas';

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

async function bumpScheduler(env: Env): Promise<void> {
	try {
		await getSchedulerStub(env).bump();
	} catch (e) {
		// Binding not configured — surface but don't block CRUD.
		console.warn('scheduler bump failed', e);
	}
}

export const addSchedule = form(
	z.object({
		name: trimmedNonEmpty('Name is required'),
		prompt: trimmedNonEmpty('Prompt is required'),
		recurrence: z.enum(['hourly', 'daily', 'weekly'], {
			errorMap: () => ({ message: 'Recurrence must be hourly, daily, or weekly' }),
		}),
		time_of_day: z.string().optional().default(''),
		day_of_week: z.string().optional().default(''),
		target_conversation_id: z.string().optional().default(''),
	}),
	async ({ name, prompt, recurrence, time_of_day, day_of_week, target_conversation_id }) => {
		const env = getEnv();
		const tod = parseTimeOfDay(time_of_day);
		const dow = Number.parseInt(day_of_week, 10);
		const targetRaw = target_conversation_id.trim();
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

export const removeSchedule = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
		const env = getEnv();
		await deleteSchedule(env, id);
		await bumpScheduler(env);
		redirect(303, '/settings');
	},
);

export const toggleSchedule = form(
	z.object({ id: positiveIntFromString, enabled: z.string().optional() }),
	async ({ id, enabled }) => {
		const env = getEnv();
		await setScheduleEnabled(env, id, enabled === 'true');
		await bumpScheduler(env);
		redirect(303, '/settings');
	},
);

export const runScheduleNow = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
		const env = getEnv();
		await bumpScheduleNow(env, id);
		await bumpScheduler(env);
		redirect(303, '/settings');
	},
);
