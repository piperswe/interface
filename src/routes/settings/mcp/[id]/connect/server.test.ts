import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer, getMcpServer, setMcpServerOauthClient } from '$lib/server/mcp_servers';
import { now as nowMs } from '$lib/server/clock';
import { GET } from './+server';

afterEach(async () => {
	vi.restoreAllMocks();
	await env.DB.prepare('DELETE FROM mcp_oauth_state').run();
	await env.DB.prepare('DELETE FROM mcp_servers').run();
});

async function callGet(idParam: string): Promise<Response> {
	const url = new URL(`http://app.example/settings/mcp/${idParam}/connect`);
	const event = {
		params: { id: idParam },
		url,
		platform: { env },
		request: new Request(url.toString()),
	} as Parameters<typeof GET>[0];
	return GET(event);
}

async function expectRedirect(promise: Promise<unknown>): Promise<URL> {
	try {
		await promise;
		throw new Error('expected redirect');
	} catch (e) {
		if (!isRedirect(e)) throw e;
		return new URL(e.location);
	}
}

async function expectError(promise: Promise<unknown>, status: number, msg?: RegExp): Promise<void> {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
		if (msg) expect(String(e.body.message)).toMatch(msg);
	}
}

function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

// Returns a fetch mock that handles the full discovery → registration flow.
function mockFullDiscovery() {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const u = String(input);
		if (u.endsWith('/.well-known/oauth-protected-resource')) {
			return jsonRes({
				authorization_servers: ['https://as.example.com'],
				scopes_supported: ['read'],
			});
		}
		if (u.endsWith('/.well-known/oauth-authorization-server')) {
			return jsonRes({
				issuer: 'https://as.example.com',
				authorization_endpoint: 'https://as.example.com/authorize',
				token_endpoint: 'https://as.example.com/token',
				registration_endpoint: 'https://as.example.com/register',
				scopes_supported: ['read', 'write'],
			});
		}
		if (u === 'https://as.example.com/register') {
			return jsonRes({ client_id: 'cid-123', client_secret: 'csec-abc' });
		}
		throw new Error(`unexpected fetch ${u}`);
	});
}

describe('settings/mcp/[id]/connect +server.ts — first connect', () => {
	it('discovers + registers + redirects to the AS authorize endpoint with PKCE params', async () => {
		const id = await createMcpServer(env, {
			name: 'demo',
			transport: 'http',
			url: 'https://mcp.example.com/server',
		});
		const fetchSpy = mockFullDiscovery();
		const target = await expectRedirect(callGet(String(id)));
		expect(target.origin).toBe('https://as.example.com');
		expect(target.pathname).toBe('/authorize');
		expect(target.searchParams.get('response_type')).toBe('code');
		expect(target.searchParams.get('client_id')).toBe('cid-123');
		expect(target.searchParams.get('code_challenge_method')).toBe('S256');
		expect(target.searchParams.get('code_challenge')).toBeTruthy();
		const state = target.searchParams.get('state');
		expect(state).toBeTruthy();
		expect(target.searchParams.get('redirect_uri')).toBe(
			`http://app.example/settings/mcp/${id}/callback`,
		);
		expect(target.searchParams.get('resource')).toBe('https://mcp.example.com/server');
		expect(target.searchParams.get('scope')).toBe('read write');
		// Verify discovery + registration both fired.
		const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.endsWith('/.well-known/oauth-protected-resource'))).toBe(true);
		expect(urls.some((u) => u.endsWith('/.well-known/oauth-authorization-server'))).toBe(true);
		expect(urls).toContain('https://as.example.com/register');
		// Auth state row should exist for the redirected state.
		const row = await env.DB.prepare(
			'SELECT state, server_id FROM mcp_oauth_state WHERE state = ?',
		)
			.bind(state)
			.first<{ state: string; server_id: number }>();
		expect(row?.server_id).toBe(id);
		// Server row should now hold the discovered client_id.
		const persisted = await getMcpServer(env, id);
		expect(persisted?.oauth?.clientId).toBe('cid-123');
		expect(persisted?.oauth?.tokenEndpoint).toBe('https://as.example.com/token');
	});

	it('skips dynamic registration on a second connect (reuses stored client_id)', async () => {
		const id = await createMcpServer(env, {
			name: 'demo',
			transport: 'http',
			url: 'https://mcp.example.com/server',
		});
		// Pre-populate as if a previous connect already registered a client.
		await setMcpServerOauthClient(env, id, {
			authorizationServer: 'https://as.example.com',
			authorizationEndpoint: 'https://as.example.com/authorize',
			tokenEndpoint: 'https://as.example.com/token',
			registrationEndpoint: 'https://as.example.com/register',
			clientId: 'cached-cid',
			clientSecret: null,
			scopes: 'read',
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const target = await expectRedirect(callGet(String(id)));
		expect(target.searchParams.get('client_id')).toBe('cached-cid');
		// No upstream calls should have fired (no rediscovery, no registration).
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('settings/mcp/[id]/connect +server.ts — error paths', () => {
	it('returns 404 when the server id is unknown', async () => {
		await expectError(callGet('99999'), 404, /not found/);
	});

	it('returns 400 when the id is non-numeric', async () => {
		await expectError(callGet('abc'), 400, /Invalid id/);
	});

	it('returns 400 when the server has no URL configured', async () => {
		const id = await createMcpServer(env, { name: 'noUrl', transport: 'http' });
		await expectError(callGet(String(id)), 400, /no URL/);
	});

	it('returns 502 when AS metadata discovery fails', async () => {
		const id = await createMcpServer(env, {
			name: 'demo',
			transport: 'http',
			url: 'https://mcp.example.com/server',
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const u = String(input);
			if (u.endsWith('/.well-known/oauth-protected-resource')) return jsonRes({});
			if (u.endsWith('/.well-known/oauth-authorization-server')) {
				return new Response('boom', { status: 500 });
			}
			throw new Error(`unexpected ${u}`);
		});
		await expectError(callGet(String(id)), 502, /OAuth discovery/);
	});

	it('returns 501 when the AS lacks a registration_endpoint and no client is set', async () => {
		const id = await createMcpServer(env, {
			name: 'demo',
			transport: 'http',
			url: 'https://mcp.example.com/server',
		});
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const u = String(input);
			if (u.endsWith('/.well-known/oauth-protected-resource')) return jsonRes({});
			if (u.endsWith('/.well-known/oauth-authorization-server')) {
				return jsonRes({
					authorization_endpoint: 'https://as.example.com/authorize',
					token_endpoint: 'https://as.example.com/token',
				});
			}
			throw new Error(`unexpected ${u}`);
		});
		await expectError(callGet(String(id)), 501, /dynamic client registration/);
	});

	it('prunes expired auth-state rows before persisting fresh state', async () => {
		const id = await createMcpServer(env, {
			name: 'demo',
			transport: 'http',
			url: 'https://mcp.example.com/server',
		});
		// Seed an expired row.
		await env.DB.prepare(
			`INSERT INTO mcp_oauth_state (state, server_id, code_verifier, redirect_uri, expires_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
			.bind('stale-state', id, 'verifier', 'http://x', nowMs() - 60_000)
			.run();
		mockFullDiscovery();
		await expectRedirect(callGet(String(id)));
		const stale = await env.DB.prepare('SELECT state FROM mcp_oauth_state WHERE state = ?')
			.bind('stale-state')
			.first();
		expect(stale).toBeNull();
	});
});
