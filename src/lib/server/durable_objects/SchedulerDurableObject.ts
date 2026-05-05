// Singleton Durable Object that owns the global "scheduled prompts" alarm.
// One DO id ('singleton') is enough — schedules live in D1, so multiple
// alarms aren't needed.
//
// On `bump()` we recompute the soonest enabled `next_run_at` and reschedule
// our alarm to fire then. On `alarm()` we list overdue schedules, run each
// (post a user message into the target conversation, creating one if
// needed), and reschedule.
//
// Sub-agent runs aren't reused here yet: the schedule's prompt is posted as
// a normal user message into a conversation, so the standard generation
// loop kicks in — same defaults the user gets when they hit "send" by hand.

import { DurableObject } from 'cloudflare:workers';
import {
	listDueSchedules,
	markScheduleRun,
	nextScheduledRun,
	type Schedule,
} from '../schedules';
import { createConversation } from '../conversations';
import { getSetting } from '../settings';
import { listAllModels } from '../providers/models';
import { buildGlobalModelId } from '../providers/types';
import { getConversationStub } from './index';
import { now as nowMs } from '../clock';

const MAX_ALARM_HORIZON_MS = 24 * 60 * 60 * 1000; // never sit longer than a day before re-checking
const MIN_ALARM_DELAY_MS = 1000;

export default class SchedulerDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	// Called from `addSchedule` / `toggleSchedule` / `runScheduleNow` remote
	// functions. Recomputes the next alarm time from D1 and either sets a
	// fresh alarm or clears the existing one if no schedules are enabled.
	async bump(): Promise<void> {
		const next = await nextScheduledRun(this.env);
		if (next == null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const target = Math.max(nowMs() + MIN_ALARM_DELAY_MS, next);
		// Clamp so a misconfigured very-far-future schedule can't push the
		// alarm beyond the daily safety horizon (still useful for stuck DOs
		// that need to redrive themselves).
		const clamped = Math.min(target, nowMs() + MAX_ALARM_HORIZON_MS);
		await this.ctx.storage.setAlarm(clamped);
	}

	async alarm(): Promise<void> {
		const now = nowMs();
		const due = await listDueSchedules(this.env, now);
		for (const s of due) {
			try {
				await this.#runOne(s);
			} catch (e) {
				console.error('schedule run failed', s.id, e);
			} finally {
				await markScheduleRun(this.env, s.id, now);
			}
		}
		// Re-arm for the next due schedule.
		await this.bump();
	}

	async #runOne(s: Schedule): Promise<void> {
		const env = this.env;
		// Pick the target conversation, creating one when the schedule has
		// no fixed target (use case: morning-briefing-style schedules where
		// each fire spawns a fresh thread).
		let conversationId = s.targetConversationId;
		if (!conversationId) {
			conversationId = await createConversation(env);
		}

		// Pick a model: the user's default_model setting if set, else the first
		// configured model. If nothing is configured we silently skip — the
		// schedule sits and waits until the operator wires up a provider.
		const [defaultModelSetting, models] = await Promise.all([
			getSetting(env, 'default_model'),
			listAllModels(env),
		]);
		if (models.length === 0) {
			console.warn('schedule fired with no models configured', s.id);
			return;
		}
		const allIds = models.map((m) => buildGlobalModelId(m.providerId, m.id));
		const model = defaultModelSetting && allIds.includes(defaultModelSetting)
			? defaultModelSetting
			: allIds[0];

		const stub = getConversationStub(env, conversationId);
		const result = await stub.addUserMessage(conversationId, s.prompt, model);
		if (result.status === 'busy') {
			// Another generation is already running — try again on the next
			// alarm tick. We don't bump next_run_at here; markScheduleRun will
			// advance it to the next interval, which is fine for the listed
			// use cases (daily summaries can skip a day if the conversation
			// is mid-stream).
			console.warn('schedule busy, skipping fire', s.id);
		}
	}
}
