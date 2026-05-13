import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '$lib/server/mcp_servers';
import { createModel } from '$lib/server/providers/models';
import { createProvider } from '$lib/server/providers/store';
import { createSchedule } from '$lib/server/schedules';
import { setSetting } from '$lib/server/settings';
import { load } from './+page.server';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM schedules').run();
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
	await env.DB.prepare('DELETE FROM mcp_servers').run();
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM conversations').run();
});

type LoadEvent = Parameters<typeof load>[0];

function makeEvent(opts: { platform?: unknown } = {}): LoadEvent {
	return {
		platform: 'platform' in opts ? opts.platform : { env },
	} as unknown as LoadEvent;
}

async function expectError(promise: Promise<unknown>, status: number): Promise<void> {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
	}
}

async function loadOk(event: LoadEvent): Promise<Record<string, unknown>> {
	const result = await load(event);
	if (!result) throw new Error('load returned void');

	return result as Record<string, unknown>;
}

describe('settings/+page.server.ts — load', () => {
	it('returns 500 when platform is missing', async () => {
		await expectError(Promise.resolve(load(makeEvent({ platform: undefined }))), 500);
	});

	it('returns all enumerated lists in parallel without throwing on an empty DB', async () => {
		const data = await loadOk(makeEvent());
		expect(data.mcpServers).toEqual([]);
		expect(data.subAgents).toEqual([]);
		expect(data.providers).toEqual([]);
		expect(data.models).toEqual([]);
		expect(data.memories).toEqual([]);
		expect(data.styles).toEqual([]);
		expect(data.tags).toEqual([]);
		expect(data.schedules).toEqual([]);
		expect(data.conversations).toEqual([]);
	});

	it('forwards system prompt / user bio / default model / title model from settings', async () => {
		await setSetting(env, 'system_prompt', 'be helpful');
		await setSetting(env, 'user_bio', 'a developer');
		await setSetting(env, 'default_model', 'a/b');
		await setSetting(env, 'title_model', 'a/c');
		const data = await loadOk(makeEvent());
		expect(data.systemPrompt).toBe('be helpful');
		expect(data.userBio).toBe('a developer');
		expect(data.defaultModel).toBe('a/b');
		expect(data.titleModel).toBe('a/c');
	});

	it('coerces missing settings keys to empty strings', async () => {
		const data = await loadOk(makeEvent());
		expect(data.systemPrompt).toBe('');
		expect(data.userBio).toBe('');
		expect(data.defaultModel).toBe('');
		expect(data.titleModel).toBe('');
	});

	it('forwards mcpPresets and providerPresets from the static modules', async () => {
		const data = await loadOk(makeEvent());
		expect(Array.isArray(data.mcpPresets)).toBe(true);
		const presets = data.presets as Array<{ id: string }>;
		expect(presets.find((p) => p.id === 'openrouter')).toBeTruthy();
	});

	it('returns the configured kagiCostPer1000Searches', async () => {
		await setSetting(env, 'kagi_cost_per_1000_searches', '50');
		const data = await loadOk(makeEvent());
		expect(data.kagiCostPer1000Searches).toBe(50);
	});

	it('returns context compaction settings with defaults', async () => {
		const data = await loadOk(makeEvent());
		expect(data.contextCompactionThreshold).toBe(80);
		expect(data.contextCompactionSummaryTokens).toBe(16_384);
	});

	it('describes Worker secret keys (KAGI_KEY is bound by wrangler.test.jsonc)', async () => {
		const data = await loadOk(makeEvent());
		const secretKeys = data.secretKeys as Array<{ name: string; configured: boolean }>;
		const kagi = secretKeys.find((k) => k.name === 'KAGI_KEY');
		expect(kagi?.configured).toBe(true);
	});

	it('aggregates seeded data into the loader output', async () => {
		await createMcpServer(env, { name: 'srv', transport: 'http', url: 'https://x' });
		await createProvider(env, { apiKey: 'k', id: 'p1', type: 'anthropic' });
		await createModel(env, 'p1', { id: 'm1', name: 'Model 1' });
		await createSchedule(env, {
			dayOfWeek: null,
			name: 'daily',
			prompt: 'p',
			recurrence: 'daily',
			targetConversationId: null,
			timeOfDay: 8 * 60,
		});
		const data = await loadOk(makeEvent());
		const mcpServers = data.mcpServers as Array<{ name: string }>;
		const providers = data.providers as Array<{ id: string }>;
		const models = data.models as Array<{ id: string }>;
		const schedules = data.schedules as Array<{ name: string }>;
		expect(mcpServers.map((s) => s.name)).toEqual(['srv']);
		expect(providers.map((p) => p.id)).toEqual(['p1']);
		expect(models.map((m) => m.id)).toEqual(['m1']);
		expect(schedules.map((s) => s.name)).toEqual(['daily']);
	});
});
