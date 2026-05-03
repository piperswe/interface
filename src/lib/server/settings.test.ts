import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
	deleteSetting,
	describeProviderKeys,
	getContextCompactionSummaryTokens,
	getContextCompactionThreshold,
	getModelList,
	getSetting,
	getSystemPrompt,
	getUserBio,
	KNOWN_PROVIDER_KEYS,
	listSettings,
	setSetting,
} from './settings';
import { DEFAULT_MODEL_LIST } from './models/config';

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

	describe('getContextCompactionThreshold', () => {
		it('defaults to 80 when unset', async () => {
			expect(await getContextCompactionThreshold(env)).toBe(80);
		});
		it('reads the persisted integer value', async () => {
			await setSetting(env, 'context_compaction_threshold', '50');
			expect(await getContextCompactionThreshold(env)).toBe(50);
		});
		it('clamps to [0, 100]', async () => {
			await setSetting(env, 'context_compaction_threshold', '200');
			expect(await getContextCompactionThreshold(env)).toBe(100);
			await setSetting(env, 'context_compaction_threshold', '-5');
			expect(await getContextCompactionThreshold(env)).toBe(0);
		});
		it('returns the default for non-numeric values', async () => {
			await setSetting(env, 'context_compaction_threshold', 'abc');
			expect(await getContextCompactionThreshold(env)).toBe(80);
		});
	});

	describe('getContextCompactionSummaryTokens', () => {
		it('defaults to 16384 when unset', async () => {
			expect(await getContextCompactionSummaryTokens(env)).toBe(16_384);
		});
		it('reads the persisted integer value', async () => {
			await setSetting(env, 'context_compaction_summary_tokens', '4096');
			expect(await getContextCompactionSummaryTokens(env)).toBe(4096);
		});
		it('clamps below to 256', async () => {
			await setSetting(env, 'context_compaction_summary_tokens', '50');
			expect(await getContextCompactionSummaryTokens(env)).toBe(256);
		});
		it('falls back to default when non-numeric', async () => {
			await setSetting(env, 'context_compaction_summary_tokens', 'nope');
			expect(await getContextCompactionSummaryTokens(env)).toBe(16_384);
		});
	});

	describe('getSystemPrompt / getUserBio', () => {
		it('returns null when unset', async () => {
			expect(await getSystemPrompt(env)).toBeNull();
			expect(await getUserBio(env)).toBeNull();
		});
		it('returns the persisted value', async () => {
			await setSetting(env, 'system_prompt', 'You are a helpful pirate.');
			await setSetting(env, 'user_bio', 'I like cats.');
			expect(await getSystemPrompt(env)).toBe('You are a helpful pirate.');
			expect(await getUserBio(env)).toBe('I like cats.');
		});
	});

	describe('getModelList', () => {
		it('returns the defaults when unset', async () => {
			expect(await getModelList(env)).toEqual(DEFAULT_MODEL_LIST);
		});
		it('returns the parsed list when set', async () => {
			await setSetting(env, 'model_list', 'foo|Foo\nbar|Bar');
			expect(await getModelList(env)).toEqual([
				{ slug: 'foo', label: 'Foo' },
				{ slug: 'bar', label: 'Bar' },
			]);
		});
	});
});
