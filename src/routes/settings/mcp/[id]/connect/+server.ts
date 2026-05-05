import { error, redirect } from '@sveltejs/kit';
import { getMcpServer, setMcpServerOauthClient } from '$lib/server/mcp_servers';
import {
	buildAuthorizationUrl,
	discoverEndpoints,
	dynamicallyRegister,
	generateCodeVerifier,
	generateState,
	s256Challenge,
	OauthDiscoveryError,
} from '$lib/server/mcp/oauth';
import { persistAuthState, pruneExpiredAuthState } from '$lib/server/mcp/oauth_store';
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
		let discovered;
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
		await setMcpServerOauthClient(env, id, {
			authorizationServer: discovered.authorizationServer,
			authorizationEndpoint: discovered.authorizationEndpoint,
			tokenEndpoint: discovered.tokenEndpoint,
			registrationEndpoint: discovered.registrationEndpoint,
			clientId: clientId!,
			clientSecret: clientSecret,
			scopes: discovered.scopes,
		});
		oauth = {
			authorizationServer: discovered.authorizationServer,
			authorizationEndpoint: discovered.authorizationEndpoint,
			tokenEndpoint: discovered.tokenEndpoint,
			registrationEndpoint: discovered.registrationEndpoint,
			clientId,
			clientSecret,
			scopes: discovered.scopes,
			accessToken: null,
			refreshToken: null,
			expiresAt: null,
		};
	}

	const codeVerifier = generateCodeVerifier();
	const codeChallenge = await s256Challenge(codeVerifier);
	const state = generateState();
	const redirectUri = `${url.origin}/settings/mcp/${id}/callback`;
	await persistAuthState(env, { state, serverId: id, codeVerifier, redirectUri });

	const authUrl = buildAuthorizationUrl({
		authorizationEndpoint: oauth.authorizationEndpoint!,
		clientId: oauth.clientId!,
		redirectUri,
		state,
		codeChallenge,
		scopes: oauth.scopes,
		resource: server.url,
	});
	redirect(303, authUrl);
};
