// Per-user key/value settings backed by D1. Single-user mode reserves user_id=1
// (seeded by migration 0002). Phase 6 multi-user reads the user_id from the
// session.

const SINGLE_USER_ID = 1;

export type SettingRow = {
	key: string;
	value: string;
	updated_at: number;
};

export async function getSetting(env: Env, key: string, userId: number = SINGLE_USER_ID): Promise<string | null> {
	const row = await env.DB.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?')
		.bind(userId, key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string, userId: number = SINGLE_USER_ID): Promise<void> {
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO settings (user_id, key, value, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	)
		.bind(userId, key, value, now)
		.run();
}

export async function deleteSetting(env: Env, key: string, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').bind(userId, key).run();
}

export async function listSettings(env: Env, userId: number = SINGLE_USER_ID): Promise<SettingRow[]> {
	const result = await env.DB.prepare('SELECT key, value, updated_at FROM settings WHERE user_id = ? ORDER BY key')
		.bind(userId)
		.all<SettingRow>();
	return result.results ?? [];
}

// ---- Context compaction helpers ---------------------------------------------------------

export async function getContextCompactionThreshold(env: Env, userId: number = SINGLE_USER_ID): Promise<number> {
	const raw = await getSetting(env, 'context_compaction_threshold', userId);
	if (raw == null) return 80;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return 80;
	return Math.max(0, Math.min(100, n));
}

export async function getContextCompactionSummaryTokens(env: Env, userId: number = SINGLE_USER_ID): Promise<number> {
	const raw = await getSetting(env, 'context_compaction_summary_tokens', userId);
	if (raw == null) return 16_384;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return 16_384;
	return Math.max(256, n);
}

// ---- System prompt / user bio helpers -------------------------------------------------

export async function getSystemPrompt(env: Env, userId: number = SINGLE_USER_ID): Promise<string | null> {
	return getSetting(env, 'system_prompt', userId);
}

export async function getUserBio(env: Env, userId: number = SINGLE_USER_ID): Promise<string | null> {
	return getSetting(env, 'user_bio', userId);
}

// ---- Model list helpers ----------------------------------------------------------------

import { parseModelList, type ModelEntry } from './models/config';

export async function getModelList(env: Env, userId: number = SINGLE_USER_ID): Promise<ModelEntry[]> {
	const raw = await getSetting(env, 'model_list', userId);
	return parseModelList(raw);
}

// Provider keys are stored in Worker secrets (per Phase 0a Open Question 5
// default — envelope encryption deferred to Phase 6 multi-user). The Settings
// UI surfaces only "configured / not configured" status; actual key edits
// happen via `wrangler secret put`.
export type ProviderKeyName = 'OPENROUTER_KEY' | 'ANTHROPIC_KEY' | 'OPENAI_KEY' | 'GOOGLE_KEY' | 'DEEPSEEK_KEY' | 'KAGI_KEY';

export type ProviderKeyStatus = {
	name: ProviderKeyName;
	configured: boolean;
};

export const KNOWN_PROVIDER_KEYS: ProviderKeyName[] = [
	'OPENROUTER_KEY',
	'ANTHROPIC_KEY',
	'OPENAI_KEY',
	'GOOGLE_KEY',
	'DEEPSEEK_KEY',
	'KAGI_KEY',
];

export function describeProviderKeys(env: Env): ProviderKeyStatus[] {
	return KNOWN_PROVIDER_KEYS.map((name) => ({
		name,
		configured: typeof (env as unknown as Record<string, unknown>)[name] === 'string'
			&& ((env as unknown as Record<string, string>)[name] ?? '').length > 0,
	}));
}
