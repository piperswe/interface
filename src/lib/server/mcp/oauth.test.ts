import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildAuthorizationUrl,
	discoverEndpoints,
	dynamicallyRegister,
	exchangeCode,
	expiresAtFromResponse,
	generateCodeVerifier,
	generateState,
	parseResourceMetadataUrl,
	refreshAccessToken,
	s256Challenge,
} from './oauth';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('PKCE helpers', () => {
	it('generateCodeVerifier produces 43+ char base64url strings', () => {
		const v = generateCodeVerifier();
		expect(v.length).toBeGreaterThanOrEqual(43);
		expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('s256Challenge of "test" matches the well-known SHA-256 fixture', async () => {
		// RFC 7636 §B example: code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
		// → challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
		const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
		const challenge = await s256Challenge(verifier);
		expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
	});

	it('generateState produces a base64url string', () => {
		expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('two generated verifiers differ', () => {
		expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
	});
});

describe('parseResourceMetadataUrl', () => {
	it('extracts the resource_metadata parameter', () => {
		const h = 'Bearer realm="mcp", resource_metadata="https://example.com/.well-known/oauth-protected-resource"';
		expect(parseResourceMetadataUrl(h)).toBe('https://example.com/.well-known/oauth-protected-resource');
	});

	it('handles unquoted values', () => {
		expect(parseResourceMetadataUrl('Bearer resource_metadata=https://x.example/.well-known/oauth-protected-resource')).toBe(
			'https://x.example/.well-known/oauth-protected-resource',
		);
	});

	it('returns null for absent parameter', () => {
		expect(parseResourceMetadataUrl('Bearer realm="x"')).toBeNull();
		expect(parseResourceMetadataUrl(null)).toBeNull();
	});
});

describe('buildAuthorizationUrl', () => {
	it('encodes all PKCE params and code_challenge_method=S256', () => {
		const u = buildAuthorizationUrl({
			authorizationEndpoint: 'https://as.example/authorize',
			clientId: 'client123',
			redirectUri: 'https://app.example/callback',
			state: 'st4te',
			codeChallenge: 'chal',
			scopes: 'read write',
			resource: 'https://rs.example/mcp',
		});
		const parsed = new URL(u);
		expect(parsed.searchParams.get('response_type')).toBe('code');
		expect(parsed.searchParams.get('client_id')).toBe('client123');
		expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example/callback');
		expect(parsed.searchParams.get('state')).toBe('st4te');
		expect(parsed.searchParams.get('code_challenge')).toBe('chal');
		expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
		expect(parsed.searchParams.get('scope')).toBe('read write');
		expect(parsed.searchParams.get('resource')).toBe('https://rs.example/mcp');
	});
});

describe('expiresAtFromResponse', () => {
	it('returns now + expires_in*1000', () => {
		expect(expiresAtFromResponse({ access_token: 't', token_type: 'Bearer', expires_in: 60 }, 1000)).toBe(61_000);
	});
	it('returns null when expires_in is missing or non-positive', () => {
		expect(expiresAtFromResponse({ access_token: 't', token_type: 'Bearer' }, 1000)).toBeNull();
		expect(expiresAtFromResponse({ access_token: 't', token_type: 'Bearer', expires_in: 0 }, 1000)).toBeNull();
	});

	// Regression: a malicious AS could previously return expires_in=Infinity
	// to keep a stale token "valid" forever (`Infinity < nowMs() === false`,
	// so the refresh path never fires). Clamp at 1 year and reject Infinity.
	it('clamps obscenely large expires_in to the 1-year ceiling', () => {
		const out = expiresAtFromResponse(
			{ access_token: 't', token_type: 'Bearer', expires_in: 10_000_000_000 },
			0,
		);
		expect(out).toBe(31_536_000 * 1000);
	});

	it('returns null for non-finite expires_in', () => {
		expect(
			expiresAtFromResponse(
				{ access_token: 't', token_type: 'Bearer', expires_in: Infinity },
				0,
			),
		).toBeNull();
		expect(
			expiresAtFromResponse(
				{ access_token: 't', token_type: 'Bearer', expires_in: NaN },
				0,
			),
		).toBeNull();
	});
});

describe('generateState', () => {
	// Regression: state generation was 16 bytes (128 bits). Bumped to 32 bytes
	// to match the PKCE verifier strength and modern OAuth convention.
	it('produces 43-char base64url strings (32 random bytes)', () => {
		const s = generateState();
		expect(s.length).toBeGreaterThanOrEqual(43);
		expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe('discoverEndpoints', () => {
	it('walks protected-resource → authorization-server', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url === 'https://rs.example/.well-known/oauth-protected-resource') {
				return new Response(
					JSON.stringify({
						authorization_servers: ['https://as.example'],
						scopes_supported: ['read', 'write'],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			if (url === 'https://as.example/.well-known/oauth-authorization-server') {
				return new Response(
					JSON.stringify({
						issuer: 'https://as.example',
						authorization_endpoint: 'https://as.example/authorize',
						token_endpoint: 'https://as.example/token',
						registration_endpoint: 'https://as.example/register',
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		});

		const ep = await discoverEndpoints('https://rs.example/mcp');
		expect(ep.authorizationServer).toBe('https://as.example');
		expect(ep.authorizationEndpoint).toBe('https://as.example/authorize');
		expect(ep.tokenEndpoint).toBe('https://as.example/token');
		expect(ep.registrationEndpoint).toBe('https://as.example/register');
		expect(ep.scopes).toBe('read write');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('falls back to the resource origin when protected-resource is missing', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/.well-known/oauth-protected-resource')) {
				return new Response('not found', { status: 404 });
			}
			if (url === 'https://rs.example/.well-known/oauth-authorization-server') {
				return new Response(
					JSON.stringify({
						authorization_endpoint: 'https://rs.example/authorize',
						token_endpoint: 'https://rs.example/token',
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		const ep = await discoverEndpoints('https://rs.example/mcp');
		expect(ep.authorizationServer).toBe('https://rs.example');
		expect(ep.tokenEndpoint).toBe('https://rs.example/token');
	});

	// Regression: AS metadata used to be parsed without scheme validation.
	// A compromised/MITM'd metadata response could redirect every token
	// exchange (including PKCE verifier + refresh token) to attacker-
	// controlled hosts. Now we require https:// on every endpoint.
	it('rejects non-HTTPS token_endpoint in AS metadata', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/.well-known/oauth-protected-resource')) {
				return new Response('not found', { status: 404 });
			}
			if (url === 'https://rs.example/.well-known/oauth-authorization-server') {
				return new Response(
					JSON.stringify({
						authorization_endpoint: 'https://rs.example/authorize',
						token_endpoint: 'http://attacker.example/token',
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		await expect(discoverEndpoints('https://rs.example/mcp')).rejects.toThrow(
			/https/i,
		);
	});

	it('rejects mismatched issuer in AS metadata', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith('/.well-known/oauth-protected-resource')) {
				return new Response('not found', { status: 404 });
			}
			if (url === 'https://rs.example/.well-known/oauth-authorization-server') {
				return new Response(
					JSON.stringify({
						issuer: 'https://different.example',
						authorization_endpoint: 'https://rs.example/authorize',
						token_endpoint: 'https://rs.example/token',
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				);
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		await expect(discoverEndpoints('https://rs.example/mcp')).rejects.toThrow(
			/issuer/i,
		);
	});
});

describe('dynamicallyRegister', () => {
	it('POSTs the registration body and returns the issued client', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			expect(String(input)).toBe('https://as.example/register');
			expect(init?.method).toBe('POST');
			const body = JSON.parse(init!.body as string);
			expect(body.redirect_uris).toEqual(['https://app.example/callback']);
			expect(body.grant_types).toContain('authorization_code');
			return new Response(JSON.stringify({ client_id: 'abc', client_secret: 'shh' }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const reg = await dynamicallyRegister('https://as.example/register', 'https://app.example/callback', 'Test');
		expect(reg.clientId).toBe('abc');
		expect(reg.clientSecret).toBe('shh');
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('throws when the response is missing client_id', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } }),
		);
		await expect(
			dynamicallyRegister('https://as.example/register', 'https://app.example/callback', 'Test'),
		).rejects.toThrow(/client_id/);
	});
});

describe('exchangeCode / refreshAccessToken', () => {
	it('exchangeCode posts form-encoded body and parses the response', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			expect(String(input)).toBe('https://as.example/token');
			expect(init?.method).toBe('POST');
			const body = String(init!.body);
			const params = new URLSearchParams(body);
			expect(params.get('grant_type')).toBe('authorization_code');
			expect(params.get('code')).toBe('the-code');
			expect(params.get('code_verifier')).toBe('verif');
			return new Response(
				JSON.stringify({
					access_token: 'A',
					token_type: 'Bearer',
					expires_in: 3600,
					refresh_token: 'R',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const tok = await exchangeCode({
			tokenEndpoint: 'https://as.example/token',
			clientId: 'cid',
			clientSecret: null,
			code: 'the-code',
			codeVerifier: 'verif',
			redirectUri: 'https://app.example/callback',
		});
		expect(tok.access_token).toBe('A');
		expect(tok.refresh_token).toBe('R');
	});

	it('refreshAccessToken sends grant_type=refresh_token', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
			const params = new URLSearchParams(String(init!.body));
			expect(params.get('grant_type')).toBe('refresh_token');
			expect(params.get('refresh_token')).toBe('R');
			return new Response(
				JSON.stringify({ access_token: 'A2', token_type: 'Bearer', expires_in: 60 }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		});
		const tok = await refreshAccessToken({
			tokenEndpoint: 'https://as.example/token',
			clientId: 'cid',
			clientSecret: null,
			refreshToken: 'R',
		});
		expect(tok.access_token).toBe('A2');
	});

	it('throws on non-2xx token responses', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 400 }));
		await expect(
			refreshAccessToken({
				tokenEndpoint: 'https://as.example/token',
				clientId: 'c',
				clientSecret: null,
				refreshToken: 'R',
			}),
		).rejects.toThrow(/Token endpoint/);
	});
});
