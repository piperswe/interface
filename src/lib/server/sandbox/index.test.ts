import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBackend } from './index';

// Stable conversation id used across tests in this file. The backend
// selection logic depends only on env + user setting; conversation id
// doesn't influence selection.

function withEnv(overrides: Record<string, unknown>): Env {
	return { ...env, ...overrides } as unknown as Env;
}

async function setBackendSetting(value: 'cloudflare' | 'fly' | null): Promise<void> {
	if (value === null) {
		await env.DB.prepare('DELETE FROM settings WHERE user_id = 1 AND key = ?')
			.bind('sandbox_backend')
			.run();
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
	await setBackendSetting(null);
});
afterEach(async () => {
	await setBackendSetting(null);
});

describe('getBackend', () => {
	it('returns null when neither backend is configured', async () => {
		const result = await getBackend(withEnv({ SANDBOX: undefined, FLY_API_TOKEN: undefined, FLY_APP_NAME: undefined }));
		expect(result).toBeNull();
	});

	it('returns the only-available backend without reading D1 (cloudflare)', async () => {
		// Regression: tool-registry-builder.test.ts calls buildBaseToolRegistry
		// with a stripped env that has no DB, so a single-backend env must
		// short-circuit the settings lookup. Verified by running with no DB
		// configured at all.
		const fakeEnv = { SANDBOX: {}, DB: undefined } as unknown as Env;
		const result = await getBackend(fakeEnv);
		expect(result?.id).toBe('cloudflare');
	});

	it('returns the only-available backend without reading D1 (fly)', async () => {
		const fakeEnv = {
			FLY_API_TOKEN: 'tok',
			FLY_APP_NAME: 'app',
			DB: undefined,
		} as unknown as Env;
		const result = await getBackend(fakeEnv);
		expect(result?.id).toBe('fly');
	});

	it('honors the user setting when both backends are available', async () => {
		await setBackendSetting('fly');
		const both = withEnv({ SANDBOX: {}, FLY_API_TOKEN: 'tok', FLY_APP_NAME: 'app' });
		const result = await getBackend(both);
		expect(result?.id).toBe('fly');
	});

	it('falls back to an available backend when the preferred one is not configured', async () => {
		await setBackendSetting('fly');
		// Setting says fly, but fly creds aren't present → cloudflare wins.
		const cfOnly = withEnv({ SANDBOX: {}, FLY_API_TOKEN: undefined, FLY_APP_NAME: undefined });
		const result = await getBackend(cfOnly);
		expect(result?.id).toBe('cloudflare');
	});

	it('defaults to cloudflare when both are available and no setting is stored', async () => {
		const both = withEnv({ SANDBOX: {}, FLY_API_TOKEN: 'tok', FLY_APP_NAME: 'app' });
		const result = await getBackend(both);
		expect(result?.id).toBe('cloudflare');
	});
});
