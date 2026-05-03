import { error } from '@sveltejs/kit';
import { listArchivedConversations } from '$lib/server/conversations';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	return {
		archived: await listArchivedConversations(platform.env),
	};
};
