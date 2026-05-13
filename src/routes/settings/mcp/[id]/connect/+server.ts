import { error, redirect } from '@sveltejs/kit';
import {
	buildAuthorizationUrl,
	type DiscoveredOauthEndpoints,
	discoverEndpoints,
	dynamicallyRegister,
	generateCodeVerifier,
	generateState,
	OauthDiscoveryError,
	s256Challenge,
} from '$lib/server/mcp/oauth';
import { persistAuthState, pruneExpiredAuthState } from '$lib/server/mcp/oauth_store';
import { getMcpServer, setMcpServerOauthClient } from '$lib/server/mcp_servers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const env = platform.env;
	const id = Number.parseInt(params.id, 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	const server = await getMcpServer(env, id);
	if (!server) error(404, 'MCP server not found');
	if (!server.url) error(400, 'MCP server has no URL configured');

	// Best-effort cleanup of stale flow state.
	await pruneExpiredAuthState(env);

	let oauth = server.oauth;
	if (!oauth?.clientId || !oauth.authorizationEndpoint || !oauth.tokenEndpoint) {
		// Discover endpoints on first connect (or after a registration reset).
		let discovered: DiscoveredOauthEndpoints;
		try {
			discovered = await discoverEndpoints(server.url);
		} catch (e) {
			if (e instanceof OauthDiscoveryError) {
				error(502, `OAuth discovery failed: ${e.message}`);
			}
			throw e;
		}
		const redirectUri = `${url.origin}/settings/mcp/${id}/callback`;
		// Try dynamic registration if the AS supports it; otherwise the
		// operator must paste credentials (deferred TODO — for now we surface
		// an error explaining what's missing).
		let clientId = oauth?.clientId ?? null;
		let clientSecret = oauth?.clientSecret ?? null;
		if (!clientId) {
			if (!discovered.registrationEndpoint) {
				error(
					501,
					"This authorization server doesn't support dynamic client registration. Manual OAuth client setup isn't implemented yet — use a different server or open an issue.",
				);
			}
			const reg = await dynamicallyRegister(discovered.registrationEndpoint, redirectUri, 'Interface');
			clientId = reg.clientId;
			clientSecret = reg.clientSecret;
		}
		if (!clientId) error(500, 'failed to obtain OAuth client id');
		await setMcpServerOauthClient(env, id, {
			authorizationEndpoint: discovered.authorizationEndpoint,
			authorizationServer: discovered.authorizationServer,
			clientId,
			clientSecret: clientSecret,
			registrationEndpoint: discovered.registrationEndpoint,
			scopes: discovered.scopes,
			tokenEndpoint: discovered.tokenEndpoint,
		});
		oauth = {
			accessToken: null,
			authorizationEndpoint: discovered.authorizationEndpoint,
			authorizationServer: discovered.authorizationServer,
			clientId,
			clientSecret,
			expiresAt: null,
			refreshToken: null,
			registrationEndpoint: discovered.registrationEndpoint,
			scopes: discovered.scopes,
			tokenEndpoint: discovered.tokenEndpoint,
		};
	}

	const codeVerifier = generateCodeVerifier();
	const codeChallenge = await s256Challenge(codeVerifier);
	const state = generateState();
	const redirectUri = `${url.origin}/settings/mcp/${id}/callback`;
	await persistAuthState(env, { codeVerifier, redirectUri, serverId: id, state });

	const { authorizationEndpoint: authEndpoint, clientId: oauthClientId } = oauth;
	if (!authEndpoint || !oauthClientId) error(500, 'OAuth client missing required fields');
	const authUrl = buildAuthorizationUrl({
		authorizationEndpoint: authEndpoint,
		clientId: oauthClientId,
		codeChallenge,
		redirectUri,
		resource: server.url,
		scopes: oauth.scopes,
		state,
	});
	redirect(303, authUrl);
};
