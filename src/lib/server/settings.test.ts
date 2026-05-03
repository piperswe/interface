import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteSetting, describeProviderKeys, getSetting, KNOWN_PROVIDER_KEYS, listSettings, setSetting } from './settings';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM settings').run();
});

describe('settings', () => {
	it('round-trips a setting via setSetting / getSetting', async () => {
		await setSetting(env, 'theme', 'dark');
		expect(await getSetting(env, 'theme')).toBe('dark');
	});

	it('overwrites existing values', async () => {
		await setSetting(env, 'theme', 'dark');
		await setSetting(env, 'theme', 'light');
		expect(await getSetting(env, 'theme')).toBe('light');
	});

	it('returns null for unknown keys', async () => {
		expect(await getSetting(env, 'nonexistent')).toBeNull();
	});

	it('deleteSetting removes the row', async () => {
		await setSetting(env, 'theme', 'dark');
		await deleteSetting(env, 'theme');
		expect(await getSetting(env, 'theme')).toBeNull();
	});

	it('listSettings returns rows ordered by key', async () => {
		await setSetting(env, 'theme', 'dark');
		await setSetting(env, 'default_model', 'anthropic/claude-sonnet');
		const rows = await listSettings(env);
		expect(rows.map((r) => r.key)).toEqual(['default_model', 'theme']);
		expect(rows.find((r) => r.key === 'theme')?.value).toBe('dark');
	});

	it('isolates settings per user_id', async () => {
		await setSetting(env, 'theme', 'dark', 1);
		await setSetting(env, 'theme', 'light', 2);
		expect(await getSetting(env, 'theme', 1)).toBe('dark');
		expect(await getSetting(env, 'theme', 2)).toBe('light');
	});

	it('describeProviderKeys reports configured for the seeded OPENROUTER_KEY', () => {
		const statuses = describeProviderKeys(env);
		expect(statuses.find((s) => s.name === 'OPENROUTER_KEY')?.configured).toBe(true);
	});

	it('describeProviderKeys reports missing for unset keys', () => {
		const statuses = describeProviderKeys(env);
		const missing = statuses.find((s) => s.name === 'ANTHROPIC_KEY');
		expect(missing?.configured).toBe(false);
	});

	it('exports the canonical provider key list', () => {
		expect(KNOWN_PROVIDER_KEYS).toContain('OPENROUTER_KEY');
		expect(KNOWN_PROVIDER_KEYS).toContain('ANTHROPIC_KEY');
		expect(KNOWN_PROVIDER_KEYS).toContain('KAGI_KEY');
	});
});
