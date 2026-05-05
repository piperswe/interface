import { error, redirect } from '@sveltejs/kit';
import { getMcpServer } from '$lib/server/mcp_servers';
import { consumeAuthState, exchangeAndPersist } from '$lib/server/mcp/oauth_store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const env = platform.env;
	const id = Number.parseInt(params.id, 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');

	const errParam = url.searchParams.get('error');
	if (errParam) {
		const desc = url.searchParams.get('error_description') ?? '';
		error(400, `Authorization failed: ${errParam}${desc ? ` — ${desc}` : ''}`);
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state) error(400, 'Missing code or state');

	const stored = await consumeAuthState(env, state);
	if (!stored) error(400, 'Unknown or expired OAuth state');
	if (stored.serverId !== id) error(400, 'OAuth state does not match this server');

	const server = await getMcpServer(env, id);
	if (!server || !server.oauth?.tokenEndpoint || !server.oauth?.clientId) {
		error(409, 'MCP server is not awaiting an OAuth callback');
	}

	try {
		await exchangeAndPersist(
			env,
			id,
			server.oauth.tokenEndpoint,
			server.oauth.clientId,
			server.oauth.clientSecret,
			code,
			stored.codeVerifier,
			stored.redirectUri,
		);
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'Token exchange failed');
	}

	redirect(303, '/settings');
};
