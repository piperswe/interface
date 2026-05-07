// OAuth 2.1 helpers for MCP servers, per the MCP authorization spec
// (https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
//
// Discovery walks `/.well-known/oauth-protected-resource` (on the resource
// server) → `/.well-known/oauth-authorization-server` (on the authorization
// server), with sane fallbacks when servers don't advertise either. Dynamic
// client registration (RFC 7591) is used when the AS supports it; otherwise
// the operator must paste static credentials.
//
// Tokens are stored in D1 (`mcp_servers.oauth_*`); these helpers are pure
// (no D1 IO) so they're easy to unit-test.

import { z } from 'zod';
import { validateOrThrow } from '$lib/zod-utils';

const AUTH_STATE_TTL_MS = 10 * 60 * 1000;

const protectedResourceMetadataSchema = z
	.object({
		authorization_servers: z.array(z.string()).optional(),
		scopes_supported: z.array(z.string()).optional(),
		resource: z.string().optional(),
	})
	.passthrough();

const authorizationServerMetadataSchema = z
	.object({
		issuer: z.string().optional(),
		authorization_endpoint: z.string(),
		token_endpoint: z.string(),
		registration_endpoint: z.string().optional(),
		scopes_supported: z.array(z.string()).optional(),
		code_challenge_methods_supported: z.array(z.string()).optional(),
		grant_types_supported: z.array(z.string()).optional(),
		token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
	})
	.passthrough();

const dynamicRegistrationResponseSchema = z
	.object({
		client_id: z.string().optional(),
		client_secret: z.string().optional(),
	})
	.passthrough();

const tokenResponseSchema = z
	.object({
		access_token: z.string(),
		token_type: z.string(),
		expires_in: z.number().optional(),
		refresh_token: z.string().optional(),
		scope: z.string().optional(),
	})
	.passthrough();

export type ProtectedResourceMetadata = z.infer<typeof protectedResourceMetadataSchema>;

export type AuthorizationServerMetadata = z.infer<typeof authorizationServerMetadataSchema>;

export type DiscoveredOauthEndpoints = {
	authorizationServer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint: string | null;
	scopes: string | null;
};

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export class OauthDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OauthDiscoveryError';
	}
}

function joinWellKnown(base: string, path: string): string {
	const u = new URL(base);
	// `.well-known` lives at the origin per RFC 8414; we ignore any path on `base`.
	u.pathname = path;
	u.search = '';
	u.hash = '';
	return u.toString();
}

export async function discoverProtectedResource(serverUrl: string): Promise<ProtectedResourceMetadata | null> {
	const candidate = joinWellKnown(serverUrl, '/.well-known/oauth-protected-resource');
	try {
		const res = await fetch(candidate, { headers: { Accept: 'application/json' } });
		if (!res.ok) return null;
		return validateOrThrow(
			protectedResourceMetadataSchema,
			await res.json(),
			`protected resource metadata at ${candidate}`,
		);
	} catch {
		return null;
	}
}

// Pull the resource_metadata URL out of a `WWW-Authenticate: Bearer ...` header.
// Falls back to a positional probe if the server doesn't include the parameter.
export function parseResourceMetadataUrl(header: string | null): string | null {
	if (!header) return null;
	const m = /resource_metadata="?([^",]+)"?/i.exec(header);
	return m ? m[1] : null;
}

export async function discoverAuthorizationServer(asUrl: string): Promise<AuthorizationServerMetadata> {
	// RFC 8414: well-known is at the issuer's origin.
	const candidate = joinWellKnown(asUrl, '/.well-known/oauth-authorization-server');
	const res = await fetch(candidate, { headers: { Accept: 'application/json' } });
	if (!res.ok) {
		throw new OauthDiscoveryError(
			`Authorization server metadata unavailable at ${candidate} (${res.status})`,
		);
	}
	let meta: AuthorizationServerMetadata;
	try {
		meta = validateOrThrow(
			authorizationServerMetadataSchema,
			await res.json(),
			`authorization server metadata at ${candidate}`,
		);
	} catch (e) {
		throw new OauthDiscoveryError(e instanceof Error ? e.message : String(e));
	}
	if (!meta.authorization_endpoint || !meta.token_endpoint) {
		throw new OauthDiscoveryError('Authorization server metadata missing endpoints');
	}
	return meta;
}

export async function discoverEndpoints(serverUrl: string): Promise<DiscoveredOauthEndpoints> {
	const protectedMeta = await discoverProtectedResource(serverUrl);
	const asUrl =
		protectedMeta?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
	const meta = await discoverAuthorizationServer(asUrl);
	return {
		authorizationServer: asUrl,
		authorizationEndpoint: meta.authorization_endpoint,
		tokenEndpoint: meta.token_endpoint,
		registrationEndpoint: meta.registration_endpoint ?? null,
		scopes:
			(meta.scopes_supported && meta.scopes_supported.join(' ')) ||
			(protectedMeta?.scopes_supported && protectedMeta.scopes_supported.join(' ')) ||
			null,
	};
}

export type DynamicallyRegisteredClient = {
	clientId: string;
	clientSecret: string | null;
};

export async function dynamicallyRegister(
	registrationEndpoint: string,
	redirectUri: string,
	clientName: string,
): Promise<DynamicallyRegisteredClient> {
	const body = {
		client_name: clientName,
		redirect_uris: [redirectUri],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none', // PKCE-public client by default
		application_type: 'web',
	};
	const res = await fetch(registrationEndpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Dynamic client registration failed (${res.status}): ${detail.slice(0, 200)}`);
	}
	const data = validateOrThrow(
		dynamicRegistrationResponseSchema,
		await res.json(),
		`dynamic client registration response from ${registrationEndpoint}`,
	);
	if (!data.client_id) throw new Error('Registration response missing client_id');
	return { clientId: data.client_id, clientSecret: data.client_secret ?? null };
}

// PKCE: code_verifier per RFC 7636 §4.1 (43-128 chars from the unreserved
// alphabet). 32 random bytes base64url-encoded yields 43 chars, which is the
// minimum and most compact valid value.
export function generateCodeVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

export async function s256Challenge(verifier: string): Promise<string> {
	const enc = new TextEncoder().encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', enc);
	return base64UrlEncode(new Uint8Array(digest));
}

export function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	const b64 = btoa(s);
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type AuthorizationUrlInput = {
	authorizationEndpoint: string;
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	scopes?: string | null;
	resource?: string | null;
};

export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
	const u = new URL(input.authorizationEndpoint);
	u.searchParams.set('response_type', 'code');
	u.searchParams.set('client_id', input.clientId);
	u.searchParams.set('redirect_uri', input.redirectUri);
	u.searchParams.set('state', input.state);
	u.searchParams.set('code_challenge', input.codeChallenge);
	u.searchParams.set('code_challenge_method', 'S256');
	if (input.scopes) u.searchParams.set('scope', input.scopes);
	if (input.resource) u.searchParams.set('resource', input.resource);
	return u.toString();
}

export type ExchangeCodeInput = {
	tokenEndpoint: string;
	clientId: string;
	clientSecret: string | null;
	code: string;
	codeVerifier: string;
	redirectUri: string;
};

export async function exchangeCode(input: ExchangeCodeInput): Promise<TokenResponse> {
	const params = new URLSearchParams({
		grant_type: 'authorization_code',
		code: input.code,
		redirect_uri: input.redirectUri,
		client_id: input.clientId,
		code_verifier: input.codeVerifier,
	});
	if (input.clientSecret) params.set('client_secret', input.clientSecret);
	return await tokenRequest(input.tokenEndpoint, params);
}

export type RefreshTokenInput = {
	tokenEndpoint: string;
	clientId: string;
	clientSecret: string | null;
	refreshToken: string;
	scopes?: string | null;
};

export async function refreshAccessToken(input: RefreshTokenInput): Promise<TokenResponse> {
	const params = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: input.refreshToken,
		client_id: input.clientId,
	});
	if (input.clientSecret) params.set('client_secret', input.clientSecret);
	if (input.scopes) params.set('scope', input.scopes);
	return await tokenRequest(input.tokenEndpoint, params);
}

async function tokenRequest(endpoint: string, params: URLSearchParams): Promise<TokenResponse> {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		},
		body: params.toString(),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`Token endpoint error (${res.status}): ${detail.slice(0, 200)}`);
	}
	return validateOrThrow(tokenResponseSchema, await res.json(), `token response from ${endpoint}`);
}

export function expiresAtFromResponse(token: TokenResponse, now: number): number | null {
	if (typeof token.expires_in !== 'number' || token.expires_in <= 0) return null;
	return now + token.expires_in * 1000;
}

export const STATE_TTL_MS = AUTH_STATE_TTL_MS;
