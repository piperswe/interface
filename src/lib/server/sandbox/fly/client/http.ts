// HTTP plumbing for the Fly.io Machines API client.
// https://fly.io/docs/machines/api/
//
// All requests use the public endpoint (api.machines.dev), so this runs
// from a Cloudflare Worker without any private-network/WireGuard setup.
// Token is passed via `Authorization: Bearer ${FLY_API_TOKEN}`.

import { z } from 'zod';
import { formatZodError } from '$lib/zod-utils';

export const FLY_API_BASE = 'https://api.machines.dev/v1';

export type FlyConfig = {
	token: string;
	appName: string;
	appHostname: string;
};

export function flyConfigFromEnv(env: Env): FlyConfig | null {
	const token = env.FLY_API_TOKEN;
	const appName = env.FLY_APP_NAME;
	if (!token || !appName) return null;
	return {
		appHostname: env.FLY_APP_HOSTNAME ?? `${appName}.fly.dev`,
		appName,
		token,
	};
}

export class FlyApiError extends Error {
	status: number;
	body: string;
	constructor(message: string, status: number, body: string) {
		super(message);
		this.name = 'FlyApiError';
		this.status = status;
		this.body = body;
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

function logAndBuildFlyError(args: {
	method: string;
	path: string;
	status: number;
	responseBody: string;
	requestBody?: BodyInit | null;
	reason?: string;
}): FlyApiError {
	const { method, path, status, responseBody, reason } = args;
	const requestBody = typeof args.requestBody === 'string' ? args.requestBody : undefined;
	const bodyPreview = responseBody ? ` body=${truncate(responseBody, 500)}` : '';
	const reasonPart = reason ? `: ${reason}` : '';
	const message = `Fly API ${method} ${path} → ${status}${reasonPart}${bodyPreview}`;
	console.error('Fly API error', {
		method,
		path,
		reason,
		requestBody: requestBody ? truncate(requestBody, 2048) : undefined,
		responseBody: truncate(responseBody, 2048),
		status,
	});
	return new FlyApiError(message, status, responseBody);
}

export async function flyFetch(cfg: FlyConfig, path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers ?? {});
	headers.set('Authorization', `Bearer ${cfg.token}`);
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}
	return fetch(`${FLY_API_BASE}${path}`, { ...init, headers });
}

export function jsonBody<S extends z.ZodTypeAny>(schema: S, value: z.input<S>): string {
	const parsed = schema.parse(value);
	return JSON.stringify(parsed);
}

export async function flyJson<S extends z.ZodTypeAny>(
	cfg: FlyConfig,
	path: string,
	schema: S,
	init: RequestInit = {},
): Promise<z.infer<S>> {
	const resp = await flyFetch(cfg, path, init);
	const text = await resp.text();
	const method = init.method ?? 'GET';
	if (!resp.ok) {
		throw logAndBuildFlyError({ method, path, requestBody: init.body, responseBody: text, status: resp.status });
	}
	let parsedJson: unknown;
	if (text) {
		try {
			parsedJson = JSON.parse(text);
		} catch {
			throw logAndBuildFlyError({
				method,
				path,
				reason: 'non-JSON response',
				requestBody: init.body,
				responseBody: text,
				status: resp.status,
			});
		}
	}
	const result = schema.safeParse(parsedJson);
	if (!result.success) {
		throw logAndBuildFlyError({
			method,
			path,
			reason: `response failed validation (${formatZodError(result.error)})`,
			requestBody: init.body,
			responseBody: text,
			status: resp.status,
		});
	}
	return result.data;
}

// For endpoints that return an empty body or `{}`.
export const flyEmptyResponseSchema = z.unknown();

export { logAndBuildFlyError };
