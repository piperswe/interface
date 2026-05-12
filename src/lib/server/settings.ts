// Per-user key/value settings backed by D1. Single-user mode reserves user_id=1
// (seeded by migration 0002). Phase 6 multi-user reads the user_id from the
// session.

import { now as nowMs } from './clock';

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

// Defensive cap so a malformed `saveSetting` request can't push a megabyte
// of text into the system_prompt / user_bio setting and then have it
// included in every chat turn. Specific settings (system_prompt, user_bio)
// have their own UI bounds; this is a hard upper limit for any future key.
const MAX_SETTING_VALUE_LEN = 32_768;

export async function setSetting(env: Env, key: string, value: string, userId: number = SINGLE_USER_ID): Promise<void> {
	if (value.length > MAX_SETTING_VALUE_LEN) {
		throw new Error(`setting "${key}" value exceeds ${MAX_SETTING_VALUE_LEN} characters`);
	}
	const now = nowMs();
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
	// Floor at 256 (a summary needs room), cap at 65_536 so a misconfigured
	// setting cannot let the summarizer emit a multi-million-token "summary"
	// and exhaust the heartbeat / cost budget.
	return Math.max(256, Math.min(65_536, n));
}

// ---- Cost configuration helpers --------------------------------------------------------

// USD per 1000 Kagi web searches. Default mirrors Kagi's published API pricing
// (https://help.kagi.com/kagi/api/search.html — $25 per 1000 search queries).
export const DEFAULT_KAGI_COST_PER_1000_SEARCHES = 25;

export async function getKagiCostPer1000Searches(
	env: Env,
	userId: number = SINGLE_USER_ID,
): Promise<number> {
	const raw = await getSetting(env, 'kagi_cost_per_1000_searches', userId);
	if (raw == null) return DEFAULT_KAGI_COST_PER_1000_SEARCHES;
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_KAGI_COST_PER_1000_SEARCHES;
	return n;
}

// ---- Workspace I/O mode ----------------------------------------------------------------

// Controls how /workspace inside the sandbox is backed by R2:
//  - 'snapshot' (default, fastest): native ext4 directory hydrated from R2 on
//    first use; deltas sync back every 15s and on every modify-tool boundary.
//  - 'rclone-mount': FUSE mount via rclone with a local VFS cache. Slightly
//    slower than snapshot mode (FUSE overhead) but reads always go through
//    the live mount.
export type WorkspaceIoMode = 'snapshot' | 'rclone-mount';

export const DEFAULT_WORKSPACE_IO_MODE: WorkspaceIoMode = 'snapshot';

export async function getWorkspaceIoMode(env: Env, userId: number = SINGLE_USER_ID): Promise<WorkspaceIoMode> {
	const raw = await getSetting(env, 'workspace_io_mode', userId);
	if (raw === 'snapshot' || raw === 'rclone-mount') return raw;
	return DEFAULT_WORKSPACE_IO_MODE;
}

// ---- Sandbox backend ------------------------------------------------------------------

// Selects which backend implementation backs the conversation sandbox.
//  - 'cloudflare' (default): the existing Cloudflare Containers + Sandbox
//    DO path. Requires the `SANDBOX` binding.
//  - 'fly': fly.io Machines. Requires the `FLY_API_TOKEN` and `FLY_APP_NAME`
//    Worker secrets.
// The setting is honored only when the selected backend's prerequisites
// are present; otherwise `getBackend` falls back to whichever is available.
export type SandboxBackendId = 'cloudflare' | 'fly';

export const DEFAULT_SANDBOX_BACKEND: SandboxBackendId = 'cloudflare';

export async function getSandboxBackendId(
	env: Env,
	userId: number = SINGLE_USER_ID,
): Promise<SandboxBackendId> {
	const raw = await getSetting(env, 'sandbox_backend', userId);
	if (raw === 'cloudflare' || raw === 'fly') return raw;
	return DEFAULT_SANDBOX_BACKEND;
}

// ---- TTS voice ------------------------------------------------------------------------

import { DEFAULT_TTS_VOICE, isValidTtsVoice, type TtsVoice } from './tts';

export async function getTtsVoice(env: Env, userId: number = SINGLE_USER_ID): Promise<TtsVoice> {
	const raw = await getSetting(env, 'tts_voice', userId);
	if (raw && isValidTtsVoice(raw)) return raw;
	return DEFAULT_TTS_VOICE;
}

// ---- System prompt / user bio helpers -------------------------------------------------

export async function getSystemPrompt(env: Env, userId: number = SINGLE_USER_ID): Promise<string | null> {
	return getSetting(env, 'system_prompt', userId);
}

export async function getUserBio(env: Env, userId: number = SINGLE_USER_ID): Promise<string | null> {
	return getSetting(env, 'user_bio', userId);
}

// ---- Secret keys (tool-specific, not provider API keys) --------------------------------

// The Settings UI surfaces only "configured / not configured" status for
// secrets that remain as Worker secrets. Provider API keys moved to D1 in
// the providers table.
export const KNOWN_SECRET_KEYS = [
	'KAGI_KEY',
	'YNAB_TOKEN',
	'OPENWEATHERMAP_KEY',
	'SANDBOX_SSH_KEY',
] as const;

export type SecretKeyName = (typeof KNOWN_SECRET_KEYS)[number];

export type SecretKeyStatus = {
	name: SecretKeyName;
	configured: boolean;
};

export function describeSecretKeys(env: Env): SecretKeyStatus[] {
	return KNOWN_SECRET_KEYS.map((name) => {
		const raw = (env as unknown as Record<string, unknown>)[name];
		return {
			name,
			configured: typeof raw === 'string' && raw.length > 0,
		};
	});
}
