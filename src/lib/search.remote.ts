import { query } from '$app/server';
import { searchConversations as searchD1, type SearchHit } from '$lib/server/search';
import { getEnv } from '$lib/server/remote-helpers';

// Cmd-K palette query. Empty input returns no rows; the caller debounces
// keystrokes (see `SearchPalette.svelte`).
export const searchConversations = query('unchecked', async (q: string): Promise<SearchHit[]> => {
	if (typeof q !== 'string') return [];
	const trimmed = q.trim();
	if (!trimmed) return [];
	return await searchD1(getEnv(), trimmed, 30);
});
