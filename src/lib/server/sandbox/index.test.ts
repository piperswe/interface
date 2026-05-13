import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '$lib/server/settings';
import { _resetBackendSelectionCache, getBackend } from './index';

// Stable conversation id used across tests in this file. The backend
// selection logic depends only on env + user setting; conversation id
// doesn't influence selection.

function withEnv(overrides: Record<string, unknown>): Env {
	return { ...env, ...overrides } as unknown as Env;
}

async function setBackendSetting(value: 'cloudflare' | 'fly' | null): Promise<void> {
	if (value === null) {
		await env.DB.prepare('DELETE FROM settings WHERE user_id = 1 AND key = ?').bind('sandbox_backend').run();
	} else {
		await env.DB.prepare(
			`INSERT INTO settings (user_id, key, value, updated_at) VALUES (1, ?, ?, ?)
			 ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
			.bind('sandbox_backend', value, Date.now())
			.run();
	}
}

beforeEach(async () => {
	_resetBackendSelectionCache();
	await setBackendSetting(null);
});
afterEach(async () => {
	_resetBackendSelectionCache();
	vi.restoreAllMocks();
	await setBackendSetting(null);
});

describe('getBackend', () => {
	it('returns null when neither backend is configured', async () => {
		const result = await getBackend(withEnv({ FLY_API_TOKEN: undefined, FLY_APP_NAME: undefined, SANDBOX: undefined }));
		expect(result).toBeNull();
	});

	it('returns the only-available backend without reading D1 (cloudflare)', async () => {
		// Regression: tool-registry-builder.test.ts calls buildBaseToolRegistry
		// with a stripped env that has no DB, so a single-backend env must
		// short-circuit the settings lookup. Verified by running with no DB
		// configured at all.
		const fakeEnv = { DB: undefined, SANDBOX: {} } as unknown as Env;
		const result = await getBackend(fakeEnv);
		expect(result?.id).toBe('cloudflare');
	});

	it('returns the only-available backend without reading D1 (fly)', async () => {
		const fakeEnv = {
			DB: undefined,
			FLY_API_TOKEN: 'tok',
			FLY_APP_NAME: 'app',
		} as unknown as Env;
		const result = await getBackend(fakeEnv);
		expect(result?.id).toBe('fly');
	});

	it('honors the user setting when both backends are available', async () => {
		await setBackendSetting('fly');
		const both = withEnv({ FLY_API_TOKEN: 'tok', FLY_APP_NAME: 'app', SANDBOX: {} });
		const result = await getBackend(both);
		expect(result?.id).toBe('fly');
	});

	it('falls back to an available backend when the preferred one is not configured', async () => {
		await setBackendSetting('fly');
		// Setting says fly, but fly creds aren't present → cloudflare wins.
		const cfOnly = withEnv({ FLY_API_TOKEN: undefined, FLY_APP_NAME: undefined, SANDBOX: {} });
		const result = await getBackend(cfOnly);
		expect(result?.id).toBe('cloudflare');
	});

	it('defaults to cloudflare when both are available and no setting is stored', async () => {
		const both = withEnv({ FLY_API_TOKEN: 'tok', FLY_APP_NAME: 'app', SANDBOX: {} });
		const result = await getBackend(both);
		expect(result?.id).toBe('cloudflare');
	});

	it('caches the selection so back-to-back calls do not re-read D1', async () => {
		// Regression: a single sandbox tool call invokes
		// `getConversationSandbox` up to four times (workspace setup,
		// ssh injection, the tool body, R2 flush). Without an isolate
		// cache that's four `getSetting` D1 reads on top of the work
		// the tool already does — and the setting can't realistically
		// change mid-tool-call. Verify the cache short-circuits the
		// subsequent reads.
		await setBackendSetting('fly');
		const spy = vi.spyOn(settings, 'getSandboxBackendId');
		const both = withEnv({ FLY_API_TOKEN: 'tok', FLY_APP_NAME: 'app', SANDBOX: {} });
		const a = await getBackend(both);
		const b = await getBackend(both);
		const c = await getBackend(both);
		expect(a?.id).toBe('fly');
		expect(b?.id).toBe('fly');
		expect(c?.id).toBe('fly');
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('does not consult the setting (or the cache) when only one backend is available', async () => {
		// The available-count short-circuit must run before the cache so
		// the common single-backend case never pays for the setting
		// lookup and never pollutes the cache.
		const spy = vi.spyOn(settings, 'getSandboxBackendId');
		const cfOnly = { SANDBOX: {} } as unknown as Env;
		await getBackend(cfOnly);
		await getBackend(cfOnly);
		expect(spy).not.toHaveBeenCalled();
	});
});
