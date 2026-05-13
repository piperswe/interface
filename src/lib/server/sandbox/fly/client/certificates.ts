// Fly.io Machines API — /apps/{app_name}/certificates/… endpoints.

import { type FlyConfig, flyEmptyResponseSchema, flyFetch, flyJson, jsonBody, logAndBuildFlyError } from './http';
import {
	type CertificateCheckResponse,
	type CertificateDetail,
	certificateCheckResponseSchema,
	certificateDetailSchema,
	createAcmeCertificateRequestSchema,
	createCustomCertificateRequestSchema,
	type DestroyCustomCertificateResponse,
	destroyCustomCertificateResponseSchema,
	type ListCertificatesResponse,
	listCertificatesResponseSchema,
} from './types';

export type { CertificateCheckResponse, CertificateDetail, DestroyCustomCertificateResponse, ListCertificatesResponse };

export async function listCertificates(
	cfg: FlyConfig,
	appName: string,
	opts: { filter?: string; cursor?: string; limit?: number } = {},
): Promise<ListCertificatesResponse> {
	const params = new URLSearchParams();
	if (opts.filter) params.set('filter', opts.filter);
	if (opts.cursor) params.set('cursor', opts.cursor);
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	const qs = params.size ? `?${params}` : '';
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/certificates${qs}`, listCertificatesResponseSchema);
}

export async function requestAcmeCertificate(cfg: FlyConfig, appName: string, hostname: string): Promise<CertificateDetail> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/certificates/acme`, certificateDetailSchema, {
		body: jsonBody(createAcmeCertificateRequestSchema, { hostname }),
		method: 'POST',
	});
}

export async function uploadCustomCertificate(
	cfg: FlyConfig,
	appName: string,
	body: { hostname?: string; fullchain?: string; private_key?: string },
): Promise<CertificateDetail> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/certificates/custom`, certificateDetailSchema, {
		body: jsonBody(createCustomCertificateRequestSchema, body),
		method: 'POST',
	});
}

export async function getCertificate(cfg: FlyConfig, appName: string, hostname: string): Promise<CertificateDetail> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}`, certificateDetailSchema);
}

export async function deleteCertificate(cfg: FlyConfig, appName: string, hostname: string): Promise<void> {
	await flyJson(cfg, `/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}`, flyEmptyResponseSchema, {
		method: 'DELETE',
	});
}

export async function deleteAcmeCertificates(cfg: FlyConfig, appName: string, hostname: string): Promise<CertificateDetail> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}/acme`, certificateDetailSchema, {
		method: 'DELETE',
	});
}

export async function checkCertificate(cfg: FlyConfig, appName: string, hostname: string): Promise<CertificateCheckResponse> {
	return flyJson(
		cfg,
		`/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}/check`,
		certificateCheckResponseSchema,
		{ method: 'POST' },
	);
}

export async function deleteCustomCertificate(
	cfg: FlyConfig,
	appName: string,
	hostname: string,
): Promise<DestroyCustomCertificateResponse> {
	return flyJson(
		cfg,
		`/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}/custom`,
		destroyCustomCertificateResponseSchema,
		{ method: 'DELETE' },
	);
}

// Re-export helper for callers that need the null-safe variant.
export async function getCertificateOrNull(cfg: FlyConfig, appName: string, hostname: string): Promise<CertificateDetail | null> {
	const path = `/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}`;
	const resp = await flyFetch(cfg, path);
	if (resp.status === 404) return null;
	const text = await resp.text();
	if (!resp.ok) throw logAndBuildFlyError({ method: 'GET', path, responseBody: text, status: resp.status });
	return certificateDetailSchema.parse(JSON.parse(text));
}
