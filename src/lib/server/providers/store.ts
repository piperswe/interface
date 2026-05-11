// D1 CRUD for providers. Single-user mode reserves user_id=1.

import { now as nowMs } from '../clock';
import type { Provider, ProviderType } from './types';

const SINGLE_USER_ID = 1;

function rowToProvider(r: {
	id: string;
	type: string;
	api_key: string | null;
	endpoint: string | null;
	gateway_id: string | null;
	created_at: number;
	updated_at: number;
}): Provider {
	return {
		id: r.id,
		type: r.type as ProviderType,
		apiKey: r.api_key,
		endpoint: r.endpoint,
		gatewayId: r.gateway_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export async function listProviders(env: Env, userId: number = SINGLE_USER_ID): Promise<Provider[]> {
	const result = await env.DB.prepare(
		'SELECT id, type, api_key, endpoint, gateway_id, created_at, updated_at FROM providers WHERE user_id = ? ORDER BY created_at ASC',
	)
		.bind(userId)
		.all<{
			id: string;
			type: string;
			api_key: string | null;
			endpoint: string | null;
			gateway_id: string | null;
			created_at: number;
			updated_at: number;
		}>();
	return (result.results ?? []).map(rowToProvider);
}

export async function getProvider(env: Env, id: string, userId: number = SINGLE_USER_ID): Promise<Provider | null> {
	const row = await env.DB.prepare(
		'SELECT id, type, api_key, endpoint, gateway_id, created_at, updated_at FROM providers WHERE user_id = ? AND id = ?',
	)
		.bind(userId, id)
		.first<{
			id: string;
			type: string;
			api_key: string | null;
			endpoint: string | null;
			gateway_id: string | null;
			created_at: number;
			updated_at: number;
		}>();
	return row ? rowToProvider(row) : null;
}

export type CreateProviderInput = {
	id: string;
	type: ProviderType;
	apiKey?: string | null;
	endpoint?: string | null;
	gatewayId?: string | null;
};

// Reject provider endpoints that aren't HTTPS or that point at loopback /
// RFC 1918 / cloud-metadata IPs. The OpenAI SDK ships the configured
// `Authorization: Bearer <apiKey>` header to whatever baseURL it's given,
// so an unguarded endpoint is both an SSRF surface and an API key
// exfiltration vector. Exported for unit testing.
export function _assertValidEndpoint(endpoint: string): void {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(`Invalid provider endpoint: ${endpoint}`);
	}
	if (url.protocol !== 'https:') {
		throw new Error(`Provider endpoint must use https:// (got ${url.protocol})`);
	}
	const host = url.hostname.toLowerCase();
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (host === 'localhost' || v4) {
		const a = v4 ? Number(v4[1]) : NaN;
		const b = v4 ? Number(v4[2]) : NaN;
		if (
			host === 'localhost' ||
			a === 127 ||
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			a === 0 ||
			a >= 224
		) {
			throw new Error(`Provider endpoint must not target a private/reserved address (${host})`);
		}
	}
}

export async function createProvider(
	env: Env,
	input: CreateProviderInput,
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	if (input.endpoint) _assertValidEndpoint(input.endpoint);
	const now = nowMs();
	await env.DB.prepare(
		`INSERT INTO providers (id, type, api_key, endpoint, gateway_id, created_at, updated_at, user_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.id,
			input.type,
			input.apiKey ?? null,
			input.endpoint ?? null,
			input.gatewayId ?? null,
			now,
			now,
			userId,
		)
		.run();
}

export type UpdateProviderInput = Partial<Omit<CreateProviderInput, 'id' | 'type'>>;

export async function updateProvider(
	env: Env,
	id: string,
	input: UpdateProviderInput,
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	if (input.endpoint) _assertValidEndpoint(input.endpoint);
	const now = nowMs();
	const fields: string[] = [];
	const values: (string | number | null)[] = [];

	if ('apiKey' in input) {
		fields.push('api_key = ?');
		values.push(input.apiKey ?? null);
	}
	if ('endpoint' in input) {
		fields.push('endpoint = ?');
		values.push(input.endpoint ?? null);
	}
	if ('gatewayId' in input) {
		fields.push('gateway_id = ?');
		values.push(input.gatewayId ?? null);
	}

	if (fields.length === 0) return;

	fields.push('updated_at = ?');
	values.push(now);
	values.push(userId, id);

	await env.DB.prepare(`UPDATE providers SET ${fields.join(', ')} WHERE user_id = ? AND id = ?`)
		.bind(...values)
		.run();
}

export async function deleteProvider(env: Env, id: string, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM providers WHERE user_id = ? AND id = ?').bind(userId, id).run();
}

export function isValidProviderId(id: string): boolean {
	return /^[a-z][a-z0-9_-]{0,63}$/.test(id);
}
