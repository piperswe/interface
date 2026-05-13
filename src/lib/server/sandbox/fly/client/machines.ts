// Fly.io Machines API — /apps/{app_name}/machines/… endpoints.

import { z } from 'zod';
import { type FlyConfig, flyEmptyResponseSchema, flyFetch, flyJson, jsonBody, logAndBuildFlyError } from './http';
import {
	type CreateLeaseRequest,
	type CreateMachineRequest,
	createLeaseRequestSchema,
	createMachineRequestSchema,
	type ExecResponse,
	execResponseSchema,
	type FlyMachine,
	type FlyWaitState,
	flyMachineSchema,
	type Lease,
	leaseSchema,
	type MachineExecRequest,
	type MachineVersion,
	type MemoryResponse,
	type MetadataValueResponse,
	machineExecRequestSchema,
	machineVersionSchema,
	memoryResponseSchema,
	metadataValueResponseSchema,
	type OrgMachinesResponse,
	orgMachinesResponseSchema,
	type ProcessStat,
	processStatSchema,
	type ReclaimMemoryRequest,
	type ReclaimMemoryResponse,
	reclaimMemoryRequestSchema,
	reclaimMemoryResponseSchema,
	type SetMemoryLimitRequest,
	type SignalRequest,
	type StopRequest,
	setMemoryLimitRequestSchema,
	signalRequestSchema,
	stopRequestSchema,
	type UpdateMachineRequest,
	type UpdateMetadataRequest,
	type UpsertMetadataKeyRequest,
	updateMachineRequestSchema,
	updateMetadataRequestSchema,
	upsertMetadataKeyRequestSchema,
	type WaitMachineResponse,
	waitMachineResponseSchema,
} from './types';

// Re-export types callers need to reference.
export type {
	CreateLeaseRequest,
	CreateMachineRequest,
	ExecResponse,
	FlyMachine,
	FlyWaitState,
	Lease,
	MachineExecRequest,
	MachineVersion,
	MemoryResponse,
	MetadataValueResponse,
	OrgMachinesResponse,
	ProcessStat,
	ReclaimMemoryRequest,
	ReclaimMemoryResponse,
	SetMemoryLimitRequest,
	SignalRequest,
	StopRequest,
	UpdateMachineRequest,
	UpdateMetadataRequest,
	UpsertMetadataKeyRequest,
	WaitMachineResponse,
};

// ---- List ----------------------------------------------------------------

export async function listMachines(
	cfg: FlyConfig,
	opts: { include_deleted?: boolean; region?: string; state?: string; summary?: boolean } = {},
): Promise<FlyMachine[]> {
	const params = new URLSearchParams();
	if (opts.include_deleted !== undefined) params.set('include_deleted', String(opts.include_deleted));
	if (opts.region) params.set('region', opts.region);
	if (opts.state) params.set('state', opts.state);
	if (opts.summary !== undefined) params.set('summary', String(opts.summary));
	const qs = params.size ? `?${params}` : '';
	return flyJson(cfg, `/apps/${cfg.appName}/machines${qs}`, z.array(flyMachineSchema));
}

// ---- Create --------------------------------------------------------------

export async function createMachine(cfg: FlyConfig, body: CreateMachineRequest): Promise<FlyMachine> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines`, flyMachineSchema, {
		body: jsonBody(createMachineRequestSchema, body),
		method: 'POST',
	});
}

// ---- Get -----------------------------------------------------------------

export async function getMachine(cfg: FlyConfig, machineId: string): Promise<FlyMachine | null> {
	const path = `/apps/${cfg.appName}/machines/${machineId}`;
	const resp = await flyFetch(cfg, path);
	if (resp.status === 404) return null;
	const text = await resp.text();
	if (!resp.ok) {
		throw logAndBuildFlyError({ method: 'GET', path, responseBody: text, status: resp.status });
	}
	let parsedJson: unknown;
	try {
		parsedJson = text ? JSON.parse(text) : undefined;
	} catch {
		throw logAndBuildFlyError({ method: 'GET', path, reason: 'non-JSON response', responseBody: text, status: resp.status });
	}
	const result = flyMachineSchema.safeParse(parsedJson);
	if (!result.success) {
		const { formatZodError } = await import('$lib/zod-utils');
		throw logAndBuildFlyError({
			method: 'GET',
			path,
			reason: `response failed validation (${formatZodError(result.error)})`,
			responseBody: text,
			status: resp.status,
		});
	}
	return result.data;
}

// ---- Update --------------------------------------------------------------

export async function updateMachine(cfg: FlyConfig, machineId: string, body: UpdateMachineRequest): Promise<FlyMachine> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}`, flyMachineSchema, {
		body: jsonBody(updateMachineRequestSchema, body),
		method: 'POST',
	});
}

// ---- Destroy -------------------------------------------------------------

export async function destroyMachine(cfg: FlyConfig, machineId: string, force = true): Promise<void> {
	const path = `/apps/${cfg.appName}/machines/${machineId}${force ? '?force=true' : ''}`;
	const resp = await flyFetch(cfg, path, { method: 'DELETE' });
	if (!resp.ok && resp.status !== 404) {
		throw logAndBuildFlyError({ method: 'DELETE', path, responseBody: await resp.text(), status: resp.status });
	}
}

// ---- Cordon / Uncordon ---------------------------------------------------

export async function cordonMachine(cfg: FlyConfig, machineId: string): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/cordon`, flyEmptyResponseSchema, { method: 'POST' });
}

export async function uncordonMachine(cfg: FlyConfig, machineId: string): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/uncordon`, flyEmptyResponseSchema, { method: 'POST' });
}

// ---- Events --------------------------------------------------------------

export async function listMachineEvents(cfg: FlyConfig, machineId: string, limit?: number): Promise<FlyMachine['events']> {
	const qs = limit !== undefined ? `?limit=${limit}` : '';
	const { flyMachineEventSchema } = await import('./types');
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/events${qs}`, z.array(flyMachineEventSchema));
}

// ---- Exec ----------------------------------------------------------------

export async function execMachine(cfg: FlyConfig, machineId: string, body: MachineExecRequest): Promise<ExecResponse> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/exec`, execResponseSchema, {
		body: jsonBody(machineExecRequestSchema, body),
		method: 'POST',
	});
}

// ---- Lease ---------------------------------------------------------------

export async function getMachineLease(cfg: FlyConfig, machineId: string): Promise<Lease> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/lease`, leaseSchema);
}

export async function createMachineLease(cfg: FlyConfig, machineId: string, body: CreateLeaseRequest, leaseNonce?: string): Promise<Lease> {
	const headers: Record<string, string> = {};
	if (leaseNonce) headers['fly-machine-lease-nonce'] = leaseNonce;
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/lease`, leaseSchema, {
		body: jsonBody(createLeaseRequestSchema, body),
		headers,
		method: 'POST',
	});
}

export async function releaseMachineLease(cfg: FlyConfig, machineId: string, leaseNonce: string): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/lease`, flyEmptyResponseSchema, {
		headers: { 'fly-machine-lease-nonce': leaseNonce },
		method: 'DELETE',
	});
}

// ---- Memory --------------------------------------------------------------

export async function getMachineMemory(cfg: FlyConfig, machineId: string): Promise<MemoryResponse> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/memory`, memoryResponseSchema);
}

export async function setMachineMemoryLimit(cfg: FlyConfig, machineId: string, body: SetMemoryLimitRequest): Promise<MemoryResponse> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/memory`, memoryResponseSchema, {
		body: jsonBody(setMemoryLimitRequestSchema, body),
		method: 'PUT',
	});
}

export async function reclaimMachineMemory(cfg: FlyConfig, machineId: string, body: ReclaimMemoryRequest): Promise<ReclaimMemoryResponse> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/memory/reclaim`, reclaimMemoryResponseSchema, {
		body: jsonBody(reclaimMemoryRequestSchema, body),
		method: 'POST',
	});
}

// ---- Metadata ------------------------------------------------------------

export async function getMachineMetadata(cfg: FlyConfig, machineId: string): Promise<Record<string, string>> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/metadata`, z.record(z.string(), z.string()));
}

export async function updateMachineMetadata(cfg: FlyConfig, machineId: string, body: UpdateMetadataRequest): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/metadata`, flyEmptyResponseSchema, {
		body: jsonBody(updateMetadataRequestSchema, body),
		method: 'PUT',
	});
}

export async function getMetadataValue(cfg: FlyConfig, machineId: string, key: string): Promise<MetadataValueResponse | null> {
	const path = `/apps/${cfg.appName}/machines/${machineId}/metadata/${encodeURIComponent(key)}`;
	const resp = await flyFetch(cfg, path);
	if (resp.status === 404) return null;
	const text = await resp.text();
	if (!resp.ok) throw logAndBuildFlyError({ method: 'GET', path, responseBody: text, status: resp.status });
	return metadataValueResponseSchema.parse(JSON.parse(text));
}

export async function upsertMetadataKey(cfg: FlyConfig, machineId: string, key: string, body: UpsertMetadataKeyRequest): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/metadata/${encodeURIComponent(key)}`, flyEmptyResponseSchema, {
		body: jsonBody(upsertMetadataKeyRequestSchema, body),
		method: 'POST',
	});
}

export async function deleteMetadataKey(cfg: FlyConfig, machineId: string, key: string): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/metadata/${encodeURIComponent(key)}`, flyEmptyResponseSchema, {
		method: 'DELETE',
	});
}

// ---- Processes -----------------------------------------------------------

export async function listMachineProcesses(
	cfg: FlyConfig,
	machineId: string,
	opts: { sort_by?: string; order?: string } = {},
): Promise<ProcessStat[]> {
	const params = new URLSearchParams();
	if (opts.sort_by) params.set('sort_by', opts.sort_by);
	if (opts.order) params.set('order', opts.order);
	const qs = params.size ? `?${params}` : '';
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/ps${qs}`, z.array(processStatSchema));
}

// ---- Restart -------------------------------------------------------------

export async function restartMachine(cfg: FlyConfig, machineId: string, opts: { timeout?: string; signal?: string } = {}): Promise<void> {
	const params = new URLSearchParams();
	if (opts.timeout) params.set('timeout', opts.timeout);
	if (opts.signal) params.set('signal', opts.signal);
	const qs = params.size ? `?${params}` : '';
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/restart${qs}`, flyEmptyResponseSchema, { method: 'POST' });
}

// ---- Signal --------------------------------------------------------------

export async function signalMachine(cfg: FlyConfig, machineId: string, body: SignalRequest): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/signal`, flyEmptyResponseSchema, {
		body: jsonBody(signalRequestSchema, body),
		method: 'POST',
	});
}

// ---- Start ---------------------------------------------------------------

export async function startMachine(cfg: FlyConfig, machineId: string): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/start`, flyEmptyResponseSchema, { method: 'POST' });
}

// ---- Stop ----------------------------------------------------------------

export async function stopMachine(cfg: FlyConfig, machineId: string, body?: StopRequest): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/stop`, flyEmptyResponseSchema, {
		...(body ? { body: jsonBody(stopRequestSchema, body) } : {}),
		method: 'POST',
	});
}

// ---- Suspend -------------------------------------------------------------

export async function suspendMachine(cfg: FlyConfig, machineId: string): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/suspend`, flyEmptyResponseSchema, { method: 'POST' });
}

// ---- Versions ------------------------------------------------------------

export async function listMachineVersions(cfg: FlyConfig, machineId: string): Promise<MachineVersion[]> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/versions`, z.array(machineVersionSchema));
}

// ---- Wait ----------------------------------------------------------------

export async function waitForMachineState(
	cfg: FlyConfig,
	machineId: string,
	state: FlyWaitState,
	timeoutSeconds = 20,
	opts: { version?: string; instance_id?: string; from_event_id?: string } = {},
): Promise<WaitMachineResponse> {
	const params = new URLSearchParams({ state, timeout: String(timeoutSeconds) });
	if (opts.version) params.set('version', opts.version);
	if (opts.instance_id) params.set('instance_id', opts.instance_id);
	if (opts.from_event_id) params.set('from_event_id', opts.from_event_id);
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/wait?${params}`, waitMachineResponseSchema);
}

// ---- Org-level machine list ----------------------------------------------

export async function listOrgMachines(
	cfg: FlyConfig,
	orgSlug: string,
	opts: {
		include_deleted?: boolean;
		region?: string;
		state?: string;
		summary?: boolean;
		updated_after?: string;
		cursor?: string;
		limit?: number;
	} = {},
): Promise<OrgMachinesResponse> {
	const params = new URLSearchParams();
	if (opts.include_deleted !== undefined) params.set('include_deleted', String(opts.include_deleted));
	if (opts.region) params.set('region', opts.region);
	if (opts.state) params.set('state', opts.state);
	if (opts.summary !== undefined) params.set('summary', String(opts.summary));
	if (opts.updated_after) params.set('updated_after', opts.updated_after);
	if (opts.cursor) params.set('cursor', opts.cursor);
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	const qs = params.size ? `?${params}` : '';
	return flyJson(cfg, `/orgs/${encodeURIComponent(orgSlug)}/machines${qs}`, orgMachinesResponseSchema);
}
