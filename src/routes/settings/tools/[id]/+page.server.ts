import { error } from '@sveltejs/kit';
import { getCustomTool } from '$lib/server/custom_tools';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, params }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const id = Number.parseInt(params.id, 10);
	if (!Number.isFinite(id) || id <= 0) error(404, 'Not found');
	const tool = await getCustomTool(platform.env, id);
	if (!tool) error(404, 'Custom tool not found');
	return { tool };
};
