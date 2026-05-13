// Fly.io Machines API — /apps/… and /apps/{app_name}/ip_assignments/… endpoints.

import { type FlyConfig, flyEmptyResponseSchema, flyFetch, flyJson, jsonBody, logAndBuildFlyError } from './http';
import {
	type App,
	type AssignIPRequest,
	appSchema,
	assignIPRequestSchema,
	type CreateAppDeployTokenRequest,
	type CreateAppRequest,
	type CreateAppResponse,
	createAppDeployTokenRequestSchema,
	createAppRequestSchema,
	createAppResponseSchema,
	type IPAssignment,
	iPAssignmentSchema,
	type ListAppsResponse,
	listAppsResponseSchema,
	listIPAssignmentsResponseSchema,
} from './types';

export type { App, AssignIPRequest, CreateAppDeployTokenRequest, CreateAppRequest, CreateAppResponse, IPAssignment, ListAppsResponse };

// ---- Apps ----------------------------------------------------------------

export async function listApps(cfg: FlyConfig, orgSlug: string, appRole?: string): Promise<ListAppsResponse> {
	const params = new URLSearchParams({ org_slug: orgSlug });
	if (appRole) params.set('app_role', appRole);
	return flyJson(cfg, `/apps?${params}`, listAppsResponseSchema);
}

export async function createApp(cfg: FlyConfig, body: CreateAppRequest): Promise<void> {
	await flyJson(cfg, '/apps', flyEmptyResponseSchema, {
		body: jsonBody(createAppRequestSchema, body),
		method: 'POST',
	});
}

export async function getApp(cfg: FlyConfig, appName: string): Promise<App> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}`, appSchema);
}

export async function deleteApp(cfg: FlyConfig, appName: string): Promise<void> {
	const path = `/apps/${encodeURIComponent(appName)}`;
	const resp = await flyFetch(cfg, path, { method: 'DELETE' });
	if (!resp.ok) {
		throw logAndBuildFlyError({ method: 'DELETE', path, responseBody: await resp.text(), status: resp.status });
	}
}

// ---- Deploy token --------------------------------------------------------

export async function createAppDeployToken(cfg: FlyConfig, appName: string, body: CreateAppDeployTokenRequest): Promise<CreateAppResponse> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/deploy_token`, createAppResponseSchema, {
		body: jsonBody(createAppDeployTokenRequestSchema, body),
		method: 'POST',
	});
}

// ---- IP Assignments ------------------------------------------------------

export async function listIPAssignments(cfg: FlyConfig, appName: string): Promise<IPAssignment[]> {
	const resp = await flyJson(cfg, `/apps/${encodeURIComponent(appName)}/ip_assignments`, listIPAssignmentsResponseSchema);
	return resp.ips ?? [];
}

export async function createIPAssignment(cfg: FlyConfig, appName: string, body: AssignIPRequest): Promise<IPAssignment> {
	return flyJson(cfg, `/apps/${encodeURIComponent(appName)}/ip_assignments`, iPAssignmentSchema, {
		body: jsonBody(assignIPRequestSchema, body),
		method: 'POST',
	});
}

export async function deleteIPAssignment(cfg: FlyConfig, appName: string, ip: string): Promise<void> {
	await flyJson(cfg, `/apps/${encodeURIComponent(appName)}/ip_assignments/${encodeURIComponent(ip)}`, flyEmptyResponseSchema, {
		method: 'DELETE',
	});
}
