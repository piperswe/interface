// Fly.io Machines API — /platform/… endpoints.

import { type FlyConfig, flyJson, jsonBody } from './http';
import {
	type GetPlacementsRequest,
	type GetPlacementsResponse,
	getPlacementsRequestSchema,
	getPlacementsResponseSchema,
	type RegionResponse,
	regionResponseSchema,
} from './types';

export type { GetPlacementsRequest, GetPlacementsResponse, RegionResponse };

export async function getPlacements(cfg: FlyConfig, body: GetPlacementsRequest): Promise<GetPlacementsResponse> {
	return flyJson(cfg, '/platform/placements', getPlacementsResponseSchema, {
		body: jsonBody(getPlacementsRequestSchema, body),
		method: 'POST',
	});
}

export async function getRegions(cfg: FlyConfig): Promise<RegionResponse> {
	return flyJson(cfg, '/platform/regions', regionResponseSchema);
}
