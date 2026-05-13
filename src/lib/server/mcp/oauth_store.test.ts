import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDefined } from '../../../../test/assert-defined';
import { createMcpServer, getMcpServer, setMcpServerOauthClient, setMcpServerOauthTokens } from '../mcp_servers';
import {
	consumeAuthState,
	exchangeAndPersist,
	getValidAccessToken,
	persistAuthState,
	persistTokens,
	pruneExpiredAuthState,
} from './oauth_store';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM mcp_oauth_state').run();
	await env.DB.prepare('DELETE FROM mcp_servers').run();
	vi.restoreAllMocks();
});

async function seedServer(): Promise<number> {
	return createMcpServer(env, { name: 'gh', transport: 'http', url: 'https://gh.example/mcp' });
}

describe('persistAuthState / consumeAuthState', () => {
	it('round-trips state and deletes on consume', async () => {
		const id = await seedServer();
		await persistAuthState(env, {
			codeVerifier: 'v',
			redirectUri: 'https://app.example/cb',
			serverId: id,
			state: 'state-a',
		});
		const out = await consumeAuthState(env, 'state-a');
		expect(out).toMatchObject({ codeVerifier: 'v', redirectUri: 'https://app.example/cb', serverId: id, state: 'state-a' });
		// Second consume returns null — single-use.
		expect(await consumeAuthState(env, 'state-a')).toBeNull();
	});

	it('returns null for unknown state', async () => {
		expect(await consumeAuthState(env, 'never-existed')).toBeNull();
	});

	it('returns null for expired state and still deletes the row', async () => {
		const id = await seedServer();
		// Insert an already-expired row.
		await env.DB.prepare(
			`INSERT INTO mcp_oauth_state (state, server_id, code_verifier, redirect_uri, expires_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
			.bind('expired', id, 'v', 'r', Date.now() - 60_000)
			.run();
		expect(await consumeAuthState(env, 'expired')).toBeNull();
		// Re-querying confirms the row is gone (consumed-then-rejected pattern).
		const row = await env.DB.prepare('SELECT state FROM mcp_oauth_state WHERE state = ?').bind('expired').first();
		expect(row).toBeNull();
	});

	it('pruneExpiredAuthState only deletes expired rows', async () => {
		const id = await seedServer();
		const future = Date.now() + 60_000;
		const past = Date.now() - 60_000;
		await env.DB.prepare(
			`INSERT INTO mcp_oauth_state (state, server_id, code_verifier, redirect_uri, expires_at) VALUES
				('keep', ?, 'v', 'r', ?),
				('drop', ?, 'v', 'r', ?)`,
		)
			.bind(id, future, id, past)
			.run();
		await pruneExpiredAuthState(env);
		const remaining = (await env.DB.prepare('SELECT state FROM mcp_oauth_state ORDER BY state').all()).results;
		expect(remaining.map((r) => (r as { state: string }).state)).toEqual(['keep']);
	});
});

describe('persistTokens', () => {
	it('writes access_token + refresh_token + expiresAt', async () => {
		const id = await seedServer();
		const before = Date.now();
		await persistTokens(env, id, {
			access_token: 'AT',
			expires_in: 60,
			refresh_token: 'RT',
			token_type: 'Bearer',
		});
		const row = await getMcpServer(env, id);
		expect(row?.oauth?.accessToken).toBe('AT');
		expect(row?.oauth?.refreshToken).toBe('RT');
		expect(row?.oauth?.expiresAt).toBeGreaterThanOrEqual(before + 60_000 - 5);
		expect(row?.enabled).toBe(true);
	});

	it('handles missing expires_in (stores null)', async () => {
		const id = await seedServer();
		await persistTokens(env, id, { access_token: 'AT', token_type: 'Bearer' });
		const row = await getMcpServer(env, id);
		expect(row?.oauth?.expiresAt).toBeNull();
	});
});

describe('getValidAccessToken', () => {
	it('returns null when no oauth state', async () => {
		const id = await seedServer();
		const tok = await getValidAccessToken(env, id, null);
		expect(tok).toBeNull();
	});

	it('returns the cached token when not near expiry', async () => {
		const id = await seedServer();
		await setMcpServerOauthClient(env, id, {
			authorizationEndpoint: 'https://as.example/authorize',
			authorizationServer: 'https://as.example',
			clientId: 'cid',
			clientSecret: null,
			registrationEndpoint: null,
			scopes: null,
			tokenEndpoint: 'https://as.example/token',
		});
		await setMcpServerOauthTokens(env, id, {
			accessToken: 'AT',
			expiresAt: Date.now() + 5 * 60_000,
			refreshToken: 'RT',
		});
		const row = await getMcpServer(env, id);
		assertDefined(row);
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const tok = await getValidAccessToken(env, id, row.oauth);
		expect(tok).toBe('AT');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// Regression (F1): RFC 6749 §6 says "if a new refresh token is issued, ...
	// otherwise, the client MUST RETAIN the refresh token." persistTokens used
	// to do `token.refresh_token ?? null`, wiping the stored refresh token
	// on every refresh against an AS that doesn't rotate it. Now we keep the
	// existing refresh token when the AS omits a new one.
	it('retains the existing refresh token when AS returns none', async () => {
		const id = await seedServer();
		await setMcpServerOauthClient(env, id, {
			authorizationEndpoint: 'https://as.example/authorize',
			authorizationServer: 'https://as.example',
			clientId: 'cid',
			clientSecret: null,
			registrationEndpoint: null,
			scopes: null,
			tokenEndpoint: 'https://as.example/token',
		});
		await setMcpServerOauthTokens(env, id, {
			accessToken: 'AT-old',
			expiresAt: Date.now() + 5_000,
			refreshToken: 'RT-keep',
		});
		const row = await getMcpServer(env, id);
		assertDefined(row);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ access_token: 'AT-new', expires_in: 60, token_type: 'Bearer' }), {
				headers: { 'Content-Type': 'application/json' },
				status: 200,
			}),
		);
		const tok = await getValidAccessToken(env, id, row.oauth);
		expect(tok).toBe('AT-new');
		const after = await getMcpServer(env, id);
		expect(after?.oauth?.accessToken).toBe('AT-new');
		expect(after?.oauth?.refreshToken).toBe('RT-keep');
	});

	// Regression (F4): refresh used to flip `enabled = 1` on the row,
	// silently re-enabling a server the operator had explicitly disabled.
	it('does not re-enable a disabled server on background refresh', async () => {
		const id = await seedServer();
		await setMcpServerOauthClient(env, id, {
			authorizationEndpoint: 'https://as.example/authorize',
			authorizationServer: 'https://as.example',
			clientId: 'cid',
			clientSecret: null,
			registrationEndpoint: null,
			scopes: null,
			tokenEndpoint: 'https://as.example/token',
		});
		await setMcpServerOauthTokens(env, id, {
			accessToken: 'AT-old',
			expiresAt: Date.now() + 5_000,
			refreshToken: 'RT-old',
		});
		// Operator-level disable.
		await env.DB.prepare('UPDATE mcp_servers SET enabled = 0 WHERE id = ?').bind(id).run();
		const row = await getMcpServer(env, id);
		expect(row?.enabled).toBe(false);
		assertDefined(row);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: 'AT-new',
					expires_in: 60,
					refresh_token: 'RT-new',
					token_type: 'Bearer',
				}),
				{ headers: { 'Content-Type': 'application/json' }, status: 200 },
			),
		);
		await getValidAccessToken(env, id, row.oauth);
		const after = await getMcpServer(env, id);
		expect(after?.enabled).toBe(false);
	});

	it('refreshes when within the buffer and persists new tokens', async () => {
		const id = await seedServer();
		await setMcpServerOauthClient(env, id, {
			authorizationEndpoint: 'https://as.example/authorize',
			authorizationServer: 'https://as.example',
			clientId: 'cid',
			clientSecret: null,
			registrationEndpoint: null,
			scopes: null,
			tokenEndpoint: 'https://as.example/token',
		});
		await setMcpServerOauthTokens(env, id, {
			accessToken: 'AT-old',
			expiresAt: Date.now() + 5_000, // within REFRESH_BUFFER_MS (60_000)
			refreshToken: 'RT-old',
		});
		const row = await getMcpServer(env, id);
		assertDefined(row);

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			expect(String(input)).toBe('https://as.example/token');
			if (!init) throw new Error('expected init');
			const params = new URLSearchParams(String(init.body));
			expect(params.get('grant_type')).toBe('refresh_token');
			expect(params.get('refresh_token')).toBe('RT-old');
			return new Response(
				JSON.stringify({
					access_token: 'AT-new',
					expires_in: 3600,
					refresh_token: 'RT-new',
					token_type: 'Bearer',
				}),
				{ headers: { 'Content-Type': 'application/json' }, status: 200 },
			);
		});

		const tok = await getValidAccessToken(env, id, row.oauth);
		expect(tok).toBe('AT-new');
		const after = await getMcpServer(env, id);
		expect(after?.oauth?.accessToken).toBe('AT-new');
		expect(after?.oauth?.refreshToken).toBe('RT-new');
	});

	it('returns null on refresh failure and leaves stored tokens intact', async () => {
		const id = await seedServer();
		await setMcpServerOauthClient(env, id, {
			authorizationEndpoint: 'https://as.example/authorize',
			authorizationServer: 'https://as.example',
			clientId: 'cid',
			clientSecret: null,
			registrationEndpoint: null,
			scopes: null,
			tokenEndpoint: 'https://as.example/token',
		});
		await setMcpServerOauthTokens(env, id, {
			accessToken: 'AT-old',
			expiresAt: Date.now() + 5_000,
			refreshToken: 'RT-old',
		});
		const row = await getMcpServer(env, id);
		assertDefined(row);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 400 }));

		const tok = await getValidAccessToken(env, id, row.oauth);
		expect(tok).toBeNull();
		// Stored tokens should still be the old ones — operator can manually reconnect.
		const after = await getMcpServer(env, id);
		expect(after?.oauth?.accessToken).toBe('AT-old');
		expect(after?.oauth?.refreshToken).toBe('RT-old');
	});

	it('serialises concurrent refresh attempts to a single fetch', async () => {
		const id = await seedServer();
		await setMcpServerOauthClient(env, id, {
			authorizationEndpoint: 'https://as.example/authorize',
			authorizationServer: 'https://as.example',
			clientId: 'cid',
			clientSecret: null,
			registrationEndpoint: null,
			scopes: null,
			tokenEndpoint: 'https://as.example/token',
		});
		await setMcpServerOauthTokens(env, id, {
			accessToken: 'AT-old',
			expiresAt: Date.now() + 5_000,
			refreshToken: 'RT-old',
		});
		const row = await getMcpServer(env, id);
		assertDefined(row);

		let calls = 0;
		const release = (() => {
			let r: () => void = () => undefined;
			const p = new Promise<void>((res) => {
				r = res;
			});
			return { p, release: r };
		})();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			calls++;
			await release.p;
			return new Response(JSON.stringify({ access_token: 'AT-new', expires_in: 60, token_type: 'Bearer' }), {
				headers: { 'Content-Type': 'application/json' },
				status: 200,
			});
		});

		const a = getValidAccessToken(env, id, row.oauth);
		const b = getValidAccessToken(env, id, row.oauth);
		// Yield a tick so both are in the same in-flight slot.
		await new Promise((r) => setTimeout(r, 0));
		release.release();
		const [resA, resB] = await Promise.all([a, b]);
		expect(resA).toBe('AT-new');
		expect(resB).toBe('AT-new');
		expect(calls).toBe(1);
	});
});

describe('exchangeAndPersist', () => {
	it('exchanges code, persists tokens, enables the row', async () => {
		const id = await seedServer();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
			if (!init) throw new Error('expected init');
			const params = new URLSearchParams(String(init.body));
			expect(params.get('grant_type')).toBe('authorization_code');
			expect(params.get('code')).toBe('CODE');
			expect(params.get('code_verifier')).toBe('VER');
			return new Response(
				JSON.stringify({
					access_token: 'AT',
					expires_in: 7200,
					refresh_token: 'RT',
					token_type: 'Bearer',
				}),
				{ headers: { 'Content-Type': 'application/json' }, status: 200 },
			);
		});
		await env.DB.prepare('UPDATE mcp_servers SET enabled = 0 WHERE id = ?').bind(id).run();
		const tok = await exchangeAndPersist(env, id, 'https://as.example/token', 'cid', null, 'CODE', 'VER', 'https://app.example/cb');
		expect(tok.access_token).toBe('AT');
		const row = await getMcpServer(env, id);
		expect(row?.oauth?.accessToken).toBe('AT');
		expect(row?.enabled).toBe(true);
	});
});
