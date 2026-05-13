// Fly.io Machines API — /apps/{app_name}/volumes/… and org-level volume endpoints.

import { z } from 'zod';
import { type FlyConfig, flyEmptyResponseSchema, flyJson, jsonBody } from './http';
import {
	type CreateVolumeRequest,
	createVolumeRequestSchema,
	type ExtendVolumeRequest,
	type ExtendVolumeResponse,
	extendVolumeRequestSchema,
	extendVolumeResponseSchema,
	type OrgVolumesResponse,
	orgVolumesResponseSchema,
	type UpdateVolumeRequest,
	updateVolumeRequestSchema,
	type Volume,
	type VolumeSnapshot,
	volumeSchema,
	volumeSnapshotSchema,
} from './types';

export type {
	CreateVolumeRequest,
	ExtendVolumeRequest,
	ExtendVolumeResponse,
	OrgVolumesResponse,
	UpdateVolumeRequest,
	Volume,
	VolumeSnapshot,
};

// ---- List ----------------------------------------------------------------

export async function listVolumes(cfg: FlyConfig, summary?: boolean): Promise<Volume[]> {
	const qs = summary !== undefined ? `?summary=${summary}` : '';
	return flyJson(cfg, `/apps/${cfg.appName}/volumes${qs}`, z.array(volumeSchema));
}

// ---- Create --------------------------------------------------------------

export async function createVolume(cfg: FlyConfig, body: CreateVolumeRequest): Promise<Volume> {
	return flyJson(cfg, `/apps/${cfg.appName}/volumes`, volumeSchema, {
		body: jsonBody(createVolumeRequestSchema, body),
		method: 'POST',
	});
}

// ---- Get -----------------------------------------------------------------

export async function getVolume(cfg: FlyConfig, volumeId: string): Promise<Volume> {
	return flyJson(cfg, `/apps/${cfg.appName}/volumes/${encodeURIComponent(volumeId)}`, volumeSchema);
}

// ---- Update --------------------------------------------------------------

export async function updateVolume(cfg: FlyConfig, volumeId: string, body: UpdateVolumeRequest): Promise<Volume> {
	return flyJson(cfg, `/apps/${cfg.appName}/volumes/${encodeURIComponent(volumeId)}`, volumeSchema, {
		body: jsonBody(updateVolumeRequestSchema, body),
		method: 'PUT',
	});
}

// ---- Delete --------------------------------------------------------------

export async function deleteVolume(cfg: FlyConfig, volumeId: string): Promise<Volume> {
	return flyJson(cfg, `/apps/${cfg.appName}/volumes/${encodeURIComponent(volumeId)}`, volumeSchema, {
		method: 'DELETE',
	});
}

// ---- Extend --------------------------------------------------------------

export async function extendVolume(cfg: FlyConfig, volumeId: string, body: ExtendVolumeRequest): Promise<ExtendVolumeResponse> {
	return flyJson(cfg, `/apps/${cfg.appName}/volumes/${encodeURIComponent(volumeId)}/extend`, extendVolumeResponseSchema, {
		body: jsonBody(extendVolumeRequestSchema, body),
		method: 'PUT',
	});
}

// ---- Snapshots -----------------------------------------------------------

export async function listVolumeSnapshots(cfg: FlyConfig, volumeId: string): Promise<VolumeSnapshot[]> {
	return flyJson(cfg, `/apps/${cfg.appName}/volumes/${encodeURIComponent(volumeId)}/snapshots`, z.array(volumeSnapshotSchema));
}

export async function createVolumeSnapshot(cfg: FlyConfig, volumeId: string): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/volumes/${encodeURIComponent(volumeId)}/snapshots`, flyEmptyResponseSchema, {
		method: 'POST',
	});
}

// ---- Org-level volume list -----------------------------------------------

export async function listOrgVolumes(
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
): Promise<OrgVolumesResponse> {
	const params = new URLSearchParams();
	if (opts.include_deleted !== undefined) params.set('include_deleted', String(opts.include_deleted));
	if (opts.region) params.set('region', opts.region);
	if (opts.state) params.set('state', opts.state);
	if (opts.summary !== undefined) params.set('summary', String(opts.summary));
	if (opts.updated_after) params.set('updated_after', opts.updated_after);
	if (opts.cursor) params.set('cursor', opts.cursor);
	if (opts.limit !== undefined) params.set('limit', String(opts.limit));
	const qs = params.size ? `?${params}` : '';
	return flyJson(cfg, `/orgs/${encodeURIComponent(orgSlug)}/volumes${qs}`, orgVolumesResponseSchema);
}
