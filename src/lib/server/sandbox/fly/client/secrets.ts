// Fly.io Machines API — /apps/{app_name}/secrets/… and
// /apps/{app_name}/secretkeys/… endpoints.

import { type FlyConfig, flyEmptyResponseSchema, flyJson, jsonBody } from './http';
import {
	type AppSecret,
	type AppSecretsUpdateResp,
	appSecretsSchema,
	appSecretsUpdateRequestSchema,
	appSecretsUpdateRespSchema,
	type DecryptSecretkeyResponse,
	type DeleteAppSecretResponse,
	type DeleteSecretkeyResponse,
	decryptSecretkeyRequestSchema,
	decryptSecretkeyResponseSchema,
	deleteAppSecretResponseSchema,
	deleteSecretkeyResponseSchema,
	type EncryptSecretkeyResponse,
	encryptSecretkeyRequestSchema,
	encryptSecretkeyResponseSchema,
	type SecretKey,
	type SetAppSecretResponse,
	type SetSecretkeyResponse,
	type SignSecretkeyResponse,
	secretKeySchema,
	secretKeysSchema,
	setAppSecretRequestSchema,
	setAppSecretResponseSchema,
	setSecretkeyRequestSchema,
	setSecretkeyResponseSchema,
	signSecretkeyRequestSchema,
	signSecretkeyResponseSchema,
	verifySecretkeyRequestSchema,
} from './types';

export type {
	AppSecret,
	AppSecretsUpdateResp,
	DecryptSecretkeyResponse,
	DeleteAppSecretResponse,
	DeleteSecretkeyResponse,
	EncryptSecretkeyResponse,
	SecretKey,
	SetAppSecretResponse,
	SetSecretkeyResponse,
	SignSecretkeyResponse,
};

// ---- App Secrets ---------------------------------------------------------

export async function listAppSecrets(
	cfg: FlyConfig,
	appName: string,
	opts: { min_version?: string; show_secrets?: boolean } = {},
): Promise<AppSecret[]> {
	const params = new URLSearchParams();
	if (opts.min_version) params.set('min_version', opts.min_version);
	if (opts.show_secrets !== undefined) params.set('show_secrets', String(opts.show_secrets));
	const qs = params.size ? `?${params}` : '';
	const resp = await flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secrets${qs}`, appSecretsSchema);
	return resp.secrets ?? [];
}

export async function updateAppSecrets(cfg: FlyConfig, appName: string, values: Record<string, string>): Promise<AppSecretsUpdateResp> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secrets`, appSecretsUpdateRespSchema, {
		body: jsonBody(appSecretsUpdateRequestSchema, { values }),
		method: 'POST',
	});
}

export async function getAppSecret(
	cfg: FlyConfig,
	appName: string,
	secretName: string,
	opts: { min_version?: string; show_secrets?: boolean } = {},
): Promise<AppSecret> {
	const params = new URLSearchParams();
	if (opts.min_version) params.set('min_version', opts.min_version);
	if (opts.show_secrets !== undefined) params.set('show_secrets', String(opts.show_secrets));
	const qs = params.size ? `?${params}` : '';
	const { appSecretSchema } = await import('./types');
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secrets/${encodeURIComponent(secretName)}${qs}`, appSecretSchema);
}

export async function createOrUpdateAppSecret(
	cfg: FlyConfig,
	appName: string,
	secretName: string,
	value: string,
): Promise<SetAppSecretResponse> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secrets/${encodeURIComponent(secretName)}`, setAppSecretResponseSchema, {
		body: jsonBody(setAppSecretRequestSchema, { value }),
		method: 'POST',
	});
}

export async function deleteAppSecret(cfg: FlyConfig, appName: string, secretName: string): Promise<DeleteAppSecretResponse> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secrets/${encodeURIComponent(secretName)}`, deleteAppSecretResponseSchema, {
		method: 'DELETE',
	});
}

// ---- Secret Keys ---------------------------------------------------------

export async function listSecretKeys(
	cfg: FlyConfig,
	appName: string,
	opts: { min_version?: string; types?: string } = {},
): Promise<SecretKey[]> {
	const params = new URLSearchParams();
	if (opts.min_version) params.set('min_version', opts.min_version);
	if (opts.types) params.set('types', opts.types);
	const qs = params.size ? `?${params}` : '';
	const resp = await flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secretkeys${qs}`, secretKeysSchema);
	return resp.secret_keys ?? [];
}

export async function getSecretKey(cfg: FlyConfig, appName: string, secretName: string, minVersion?: string): Promise<SecretKey> {
	const qs = minVersion ? `?min_version=${encodeURIComponent(minVersion)}` : '';
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}${qs}`, secretKeySchema);
}

export async function setSecretKey(
	cfg: FlyConfig,
	appName: string,
	secretName: string,
	body: { type?: string; value?: number[] },
): Promise<SetSecretkeyResponse> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}`, setSecretkeyResponseSchema, {
		body: jsonBody(setSecretkeyRequestSchema, body),
		method: 'POST',
	});
}

export async function deleteSecretKey(cfg: FlyConfig, appName: string, secretName: string): Promise<DeleteSecretkeyResponse> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}`, deleteSecretkeyResponseSchema, {
		method: 'DELETE',
	});
}

export async function decryptWithSecretKey(
	cfg: FlyConfig,
	appName: string,
	secretName: string,
	body: { associated_data?: number[]; ciphertext?: number[] },
	minVersion?: string,
): Promise<DecryptSecretkeyResponse> {
	const qs = minVersion ? `?min_version=${encodeURIComponent(minVersion)}` : '';
	return flyJson(
		cfg,
		`/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}/decrypt${qs}`,
		decryptSecretkeyResponseSchema,
		{
			body: jsonBody(decryptSecretkeyRequestSchema, body),
			method: 'POST',
		},
	);
}

export async function encryptWithSecretKey(
	cfg: FlyConfig,
	appName: string,
	secretName: string,
	body: { associated_data?: number[]; plaintext?: number[] },
	minVersion?: string,
): Promise<EncryptSecretkeyResponse> {
	const qs = minVersion ? `?min_version=${encodeURIComponent(minVersion)}` : '';
	return flyJson(
		cfg,
		`/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}/encrypt${qs}`,
		encryptSecretkeyResponseSchema,
		{
			body: jsonBody(encryptSecretkeyRequestSchema, body),
			method: 'POST',
		},
	);
}

export async function generateSecretKey(
	cfg: FlyConfig,
	appName: string,
	secretName: string,
	body: { type?: string; value?: number[] },
): Promise<SetSecretkeyResponse> {
	return flyJson(
		cfg,
		`/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}/generate`,
		setSecretkeyResponseSchema,
		{
			body: jsonBody(setSecretkeyRequestSchema, body),
			method: 'POST',
		},
	);
}

export async function signWithSecretKey(
	cfg: FlyConfig,
	appName: string,
	secretName: string,
	plaintext: number[],
	minVersion?: string,
): Promise<SignSecretkeyResponse> {
	const qs = minVersion ? `?min_version=${encodeURIComponent(minVersion)}` : '';
	return flyJson(
		cfg,
		`/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}/sign${qs}`,
		signSecretkeyResponseSchema,
		{
			body: jsonBody(signSecretkeyRequestSchema, { plaintext }),
			method: 'POST',
		},
	);
}

export async function verifyWithSecretKey(
	cfg: FlyConfig,
	appName: string,
	secretName: string,
	body: { plaintext?: number[]; signature?: number[] },
	minVersion?: string,
): Promise<void> {
	const qs = minVersion ? `?min_version=${encodeURIComponent(minVersion)}` : '';
	await flyJson(
		cfg,
		`/apps/${encodeURIComponent(appName)}/secretkeys/${encodeURIComponent(secretName)}/verify${qs}`,
		flyEmptyResponseSchema,
		{
			body: jsonBody(verifySecretkeyRequestSchema, body),
			method: 'POST',
		},
	);
}
