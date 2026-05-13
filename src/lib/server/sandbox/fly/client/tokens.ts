// Fly.io Machines API — /tokens/… endpoints.

import { z } from 'zod';
import { type FlyConfig, flyFetch, flyJson, jsonBody, logAndBuildFlyError } from './http';
import {
	type AuthorizeResponse,
	authenticateTokenRequestSchema,
	authorizeResponseSchema,
	authorizeTokenRequestSchema,
	type CreateOIDCTokenRequest,
	type CurrentTokenResponse,
	createOIDCTokenRequestSchema,
	currentTokenResponseSchema,
	type VerifiedToken,
	verifiedTokenSchema,
} from './types';

export type { AuthorizeResponse, CreateOIDCTokenRequest, CurrentTokenResponse, VerifiedToken };

export async function authenticateToken(cfg: FlyConfig, header: string): Promise<VerifiedToken[]> {
	return flyJson(cfg, '/tokens/authenticate', z.array(verifiedTokenSchema), {
		body: jsonBody(authenticateTokenRequestSchema, { header }),
		method: 'POST',
	});
}

export async function authorizeToken(cfg: FlyConfig, body: { access?: object; header?: string }): Promise<AuthorizeResponse> {
	return flyJson(cfg, '/tokens/authorize', authorizeResponseSchema, {
		body: jsonBody(authorizeTokenRequestSchema, body),
		method: 'POST',
	});
}

export async function getCurrentToken(cfg: FlyConfig): Promise<CurrentTokenResponse> {
	return flyJson(cfg, '/tokens/current', currentTokenResponseSchema);
}

export async function requestKmsToken(cfg: FlyConfig): Promise<string> {
	const path = '/tokens/kms';
	const resp = await flyFetch(cfg, path, { method: 'POST' });
	const text = await resp.text();
	if (!resp.ok) throw logAndBuildFlyError({ method: 'POST', path, responseBody: text, status: resp.status });
	return text;
}

export async function requestOidcToken(cfg: FlyConfig, body?: CreateOIDCTokenRequest): Promise<string> {
	const path = '/tokens/oidc';
	const resp = await flyFetch(cfg, path, {
		...(body ? { body: jsonBody(createOIDCTokenRequestSchema, body) } : {}),
		method: 'POST',
	});
	const text = await resp.text();
	if (!resp.ok) throw logAndBuildFlyError({ method: 'POST', path, responseBody: text, status: resp.status });
	return text;
}
