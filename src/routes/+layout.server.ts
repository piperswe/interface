import { listConversations } from '$lib/server/conversations';
import { listTags, tagsForConversations } from '$lib/server/tags';
import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Layout-level load — runs on every request and feeds the sidebar's
// conversation list. Returning the theme too keeps the html data attribute
// in sync without a separate roundtrip.
export const load: LayoutServerLoad = async ({ platform, locals }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const env = platform.env;
	const conversations = await listConversations(env);
	const [tags, tagMap] = await Promise.all([
		listTags(env),
		tagsForConversations(env, conversations.map((c) => c.id)),
	]);
	const conversationTags: Record<string, number[]> = {};
	for (const [convId, tagList] of tagMap) {
		conversationTags[convId] = tagList.map((t) => t.id);
	}
	return {
		conversations,
		tags,
		conversationTags,
		theme: locals.theme,
	};
};
