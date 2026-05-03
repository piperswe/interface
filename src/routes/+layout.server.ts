import { listConversations } from '$lib/server/conversations';
import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Layout-level load — runs on every request and feeds the sidebar's
// conversation list. Returning the theme too keeps the html data attribute
// in sync without a separate roundtrip.
export const load: LayoutServerLoad = async ({ platform, locals }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversations = await listConversations(platform.env);
	return {
		conversations,
		theme: locals.theme,
	};
};
