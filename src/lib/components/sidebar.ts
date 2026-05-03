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
