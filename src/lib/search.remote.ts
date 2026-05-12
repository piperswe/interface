import { query, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { searchConversations as searchD1, type SearchHit } from '$lib/server/search';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

// Cmd-K palette query. Empty input returns no rows; the caller debounces
// keystrokes (see `SearchPalette.svelte`).
export const searchConversations = query(z.string(), async (q): Promise<SearchHit[]> => {
	const trimmed = q.trim();
	if (!trimmed) return [];
	return await searchD1(getEnv(), trimmed, 30);
});
