import { env } from 'cloudflare:test';
import { isRedirect } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer, getMcpServer, setMcpServerOauthClient } from '$lib/server/mcp_servers';
import { persistAuthState } from '$lib/server/mcp/oauth_store';
import { expectError } from '../../../../../../test/helpers';
import { GET } from './+server';

afterEach(async () => {
	vi.restoreAllMocks();
	await env.DB.prepare('DELETE FROM mcp_oauth_state').run();
	await env.DB.prepare('DELETE FROM mcp_servers').run();
});

async function callGet(idParam: string, search: string): Promise<Response> {
	const url = new URL(`http://app.example/settings/mcp/${idParam}/callback?${search}`);
	const event = {
		params: { id: idParam },
		url,
		platform: { env },
		request: new Request(url.toString()),
	} as Parameters<typeof GET>[0];
	return GET(event);
}

// Local variant: returns the redirect Location as a URL (resolving the
// relative path against the app origin) so the test can assert against
// query params. The shared `expectRedirect` only checks the prefix.
async function expectRedirect(promise: Promise<unknown>): Promise<URL> {
	try {
		await promise;
		throw new Error('expected redirect');
	} catch (e) {
		if (!isRedirect(e)) throw e;
		return new URL(e.location, 'http://app.example');
	}
}

async function seedReadyServer(): Promise<{ id: number; state: string }> {
	const id = await createMcpServer(env, {
		name: 'demo',
		transport: 'http',
		url: 'https://mcp.example.com/server',
	});
	await setMcpServerOauthClient(env, id, {
		authorizationServer: 'https://as.example.com',
		authorizationEndpoint: 'https://as.example.com/authorize',
		tokenEndpoint: 'https://as.example.com/token',
		registrationEndpoint: 'https://as.example.com/register',
		clientId: 'cid-1',
		clientSecret: null,
		scopes: 'read',
	});
	const state = 'state-abc';
	await persistAuthState(env, {
		state,
		serverId: id,
		codeVerifier: 'verifier-xyz',
		redirectUri: `http://app.example/settings/mcp/${id}/callback`,
	});
	return { id, state };
}

function tokenRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('settings/mcp/[id]/callback +server.ts', () => {
	it('returns 400 when both code and state are missing', async () => {
		const { id } = await seedReadyServer();
		await expectError(callGet(String(id), ''), 400, /Missing code/);
	});

	it('returns 400 when error param is present and forwards error_description', async () => {
		const { id } = await seedReadyServer();
		await expectError(
			callGet(String(id), 'error=access_denied&error_description=user+declined'),
			400,
			/access_denied — user declined/,
		);
	});

	it('returns 400 when state is unknown', async () => {
		const { id } = await seedReadyServer();
		await expectError(
			callGet(String(id), 'code=c1&state=does-not-exist'),
			400,
			/Unknown or expired/,
		);
	});

	it('returns 400 when stored serverId does not match the path id', async () => {
		const { state } = await seedReadyServer();
		const otherId = await createMcpServer(env, {
			name: 'other',
			transport: 'http',
			url: 'https://other.example.com/',
		});
		await expectError(
			callGet(String(otherId), `code=c1&state=${state}`),
			400,
			/does not match/,
		);
	});

	it('returns 409 when the server is missing tokenEndpoint or clientId', async () => {
		const id = await createMcpServer(env, {
			name: 'half',
			transport: 'http',
			url: 'https://mcp.example.com/',
		});
		const state = 'state-half';
		await persistAuthState(env, {
			state,
			serverId: id,
			codeVerifier: 'v',
			redirectUri: 'http://app/cb',
		});
		await expectError(callGet(String(id), `code=c1&state=${state}`), 409, /awaiting/);
	});

	it('successful exchange persists tokens, redirects to /settings, and POSTs grant_type=authorization_code', async () => {
		const { id, state } = await seedReadyServer();
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				tokenRes({
					access_token: 'A1',
					refresh_token: 'R1',
					expires_in: 3600,
					token_type: 'Bearer',
				}),
			);
		const dest = await expectRedirect(callGet(String(id), `code=auth-code&state=${state}`));
		expect(dest.pathname).toBe('/settings');
		expect(fetchSpy.mock.calls).toHaveLength(1);
		expect(String(fetchSpy.mock.calls[0][0])).toBe('https://as.example.com/token');
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect(init.method).toBe('POST');
		const headers = init.headers as Record<string, string>;
		expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
		const params = new URLSearchParams(init.body as string);
		expect(params.get('grant_type')).toBe('authorization_code');
		expect(params.get('code')).toBe('auth-code');
		expect(params.get('code_verifier')).toBe('verifier-xyz');
		expect(params.get('redirect_uri')).toBe(`http://app.example/settings/mcp/${id}/callback`);
		expect(params.get('client_id')).toBe('cid-1');
		// Tokens should be persisted on the server row.
		const updated = await getMcpServer(env, id);
		expect(updated?.oauth?.accessToken).toBe('A1');
		expect(updated?.oauth?.refreshToken).toBe('R1');
		expect(updated?.oauth?.expiresAt).toBeGreaterThan(0);
	});

	it('returns 502 when the token endpoint returns 4xx', async () => {
		const { id, state } = await seedReadyServer();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tokenRes({ error: 'invalid_grant' }, 400));
		await expectError(callGet(String(id), `code=c&state=${state}`), 502, /Token endpoint/);
	});

	it('state is one-shot — replaying the same state yields 400', async () => {
		const { id, state } = await seedReadyServer();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			tokenRes({ access_token: 'A', token_type: 'Bearer' }),
		);
		await expectRedirect(callGet(String(id), `code=c&state=${state}`));
		await expectError(
			callGet(String(id), `code=c&state=${state}`),
			400,
			/Unknown or expired/,
		);
	});

	it('returns 400 when the path id is not numeric', async () => {
		await expectError(callGet('abc', 'code=c&state=s'), 400, /Invalid id/);
	});
});
