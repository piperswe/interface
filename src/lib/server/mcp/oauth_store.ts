// D1-backed bookkeeping for OAuth flows + a per-server token resolver that
// transparently refreshes near-expired access tokens. The McpHttpClient
// receives a `getAccessToken` callback wired here so refresh races are
// serialised in-memory.

import { now as nowMs } from '../clock';
import {
	exchangeCode,
	refreshAccessToken,
	expiresAtFromResponse,
	STATE_TTL_MS,
	type TokenResponse,
} from './oauth';
import { setMcpServerOauthTokens } from '../mcp_servers';
import type { McpOauthState } from './types';

export type StoredAuthState = {
	state: string;
	serverId: number;
	codeVerifier: string;
	redirectUri: string;
};

export async function persistAuthState(env: Env, s: StoredAuthState): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO mcp_oauth_state (state, server_id, code_verifier, redirect_uri, expires_at)
		 VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(s.state, s.serverId, s.codeVerifier, s.redirectUri, nowMs() + STATE_TTL_MS)
		.run();
}

export async function consumeAuthState(env: Env, state: string): Promise<StoredAuthState | null> {
	const row = await env.DB.prepare(
		`SELECT state, server_id, code_verifier, redirect_uri, expires_at
		 FROM mcp_oauth_state WHERE state = ?`,
	)
		.bind(state)
		.first<{
			state: string;
			server_id: number;
			code_verifier: string;
			redirect_uri: string;
			expires_at: number;
		}>();
	if (!row) return null;
	// One-shot: delete on read to prevent replay. If the caller errors after
	// consuming, the user has to re-initiate the flow — that's the right
	// trade-off for OAuth state which is single-use by spec.
	await env.DB.prepare('DELETE FROM mcp_oauth_state WHERE state = ?').bind(state).run();
	if (row.expires_at < nowMs()) return null;
	return {
		state: row.state,
		serverId: row.server_id,
		codeVerifier: row.code_verifier,
		redirectUri: row.redirect_uri,
	};
}

export async function pruneExpiredAuthState(env: Env): Promise<void> {
	await env.DB.prepare('DELETE FROM mcp_oauth_state WHERE expires_at < ?').bind(nowMs()).run();
}

// Per-Worker mutex so concurrent tool calls on the same server don't fire
// parallel refresh requests. Refresh tokens are typically rotated on use, so
// two refreshes in flight will invalidate one of the new token pairs.
const refreshInFlight = new Map<number, Promise<string | null>>();

const REFRESH_BUFFER_MS = 60_000;

// Returns a valid access token for the given server, refreshing if needed.
// `null` means the server has no usable token (never connected, or refresh
// failed and there's no fallback).
export async function getValidAccessToken(
	env: Env,
	serverId: number,
	oauth: McpOauthState | null,
): Promise<string | null> {
	if (!oauth || !oauth.accessToken) return null;
	const expiresAt = oauth.expiresAt;
	const needsRefresh =
		expiresAt != null && expiresAt - REFRESH_BUFFER_MS < nowMs() && !!oauth.refreshToken;
	if (!needsRefresh) return oauth.accessToken;

	const existing = refreshInFlight.get(serverId);
	if (existing) return existing;

	const promise = (async (): Promise<string | null> => {
		try {
			if (!oauth.tokenEndpoint || !oauth.clientId || !oauth.refreshToken) return oauth.accessToken;
			const refreshed = await refreshAccessToken({
				tokenEndpoint: oauth.tokenEndpoint,
				clientId: oauth.clientId,
				clientSecret: oauth.clientSecret,
				refreshToken: oauth.refreshToken,
				scopes: oauth.scopes,
			});
			await persistTokens(env, serverId, refreshed);
			return refreshed.access_token;
		} catch {
			// Refresh failed (revoked? expired?). Surface `null` so the caller
			// throws and the UI prompts re-auth. Don't wipe the stored token
			// here — the operator might reconnect manually.
			return null;
		} finally {
			refreshInFlight.delete(serverId);
		}
	})();
	refreshInFlight.set(serverId, promise);
	return promise;
}

export async function persistTokens(env: Env, serverId: number, token: TokenResponse): Promise<void> {
	await setMcpServerOauthTokens(env, serverId, {
		accessToken: token.access_token,
		refreshToken: token.refresh_token ?? null,
		expiresAt: expiresAtFromResponse(token, nowMs()),
	});
}

export async function exchangeAndPersist(
	env: Env,
	serverId: number,
	tokenEndpoint: string,
	clientId: string,
	clientSecret: string | null,
	code: string,
	codeVerifier: string,
	redirectUri: string,
): Promise<TokenResponse> {
	const tokens = await exchangeCode({
		tokenEndpoint,
		clientId,
		clientSecret,
		code,
		codeVerifier,
		redirectUri,
	});
	await persistTokens(env, serverId, tokens);
	return tokens;
}
