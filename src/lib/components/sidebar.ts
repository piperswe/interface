// Pure helper used by AppShell.svelte to bucket conversations into recency
// bands. Lives in its own module so it can be unit-tested without the
// Svelte compiler.

import type { Conversation } from '$lib/types/conversation';
import { recencyBand, type RecencyBand } from '$lib/formatters';

export const BAND_ORDER: RecencyBand[] = ['today', 'this-week', 'earlier'];

export function groupByBand(conversations: Conversation[], now: number): Map<RecencyBand, Conversation[]> {
	const groups = new Map<RecencyBand, Conversation[]>();
	for (const band of BAND_ORDER) groups.set(band, []);
	for (const c of conversations) {
		const band = recencyBand(c.updated_at, now);
		groups.get(band)!.push(c);
	}
	return groups;
}

// Merge optimistic conversations with the canonical server list. When a
// fire-and-forget create commits before the layout loader query lands, the
// same id appears in both lists; spreading them naïvely produces a duplicate
// key in the sidebar's `{#each ... (c.id)}` block, and Svelte 5 aborts the
// render with `each_key_duplicate` — which detaches the sidebar `<a>` nodes
// and silently breaks SPA link clicks until refresh. Deduping inside the
// derived (rather than relying on a follow-up effect that runs a frame too
// late) keeps the rendered list keyed-unique on every frame. Server rows win;
// optimistic-only rows go first so a freshly-created chat lands at the top
// of the `today` band.
export function mergeOptimisticConversations(
	optimistic: Conversation[],
	server: Conversation[],
	archived: ReadonlySet<string>,
): Conversation[] {
	const serverIds = new Set(server.map((c) => c.id));
	const opt = optimistic.filter((c) => !serverIds.has(c.id));
	return [...opt, ...server].filter((c) => !archived.has(c.id));
}
