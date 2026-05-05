import { describe, expect, it } from 'vitest';
import type { Conversation } from '$lib/types/conversation';
import { BAND_ORDER, groupByBand, mergeOptimisticConversations } from './sidebar';

const now = 1_700_000_000_000;
const DAY = 86_400_000;

function conv(id: string, updated_at: number): Conversation {
	return { id, title: id, created_at: updated_at, updated_at };
}

describe('groupByBand', () => {
	it('returns the canonical band order', () => {
		expect(BAND_ORDER).toEqual(['today', 'this-week', 'earlier']);
	});
	it('initialises every band even when empty', () => {
		const grouped = groupByBand([], now);
		expect(grouped.get('today')).toEqual([]);
		expect(grouped.get('this-week')).toEqual([]);
		expect(grouped.get('earlier')).toEqual([]);
	});
	it('buckets each conversation into the right band', () => {
		const today = conv('a', now - 1000);
		const week = conv('b', now - 3 * DAY);
		const earlier = conv('c', now - 30 * DAY);
		const grouped = groupByBand([today, week, earlier], now);
		expect(grouped.get('today')).toEqual([today]);
		expect(grouped.get('this-week')).toEqual([week]);
		expect(grouped.get('earlier')).toEqual([earlier]);
	});
	it('preserves input order within a band', () => {
		const c1 = conv('1', now - 100);
		const c2 = conv('2', now - 200);
		const grouped = groupByBand([c1, c2], now);
		expect(grouped.get('today')).toEqual([c1, c2]);
	});
});

describe('mergeOptimisticConversations', () => {
	it('drops optimistic rows whose id appears in the server list', () => {
		// Regression: clicking a freshly-created conversation in the sidebar did
		// nothing until refresh. The optimistic entry and the server row landed
		// with the same id during the goto/invalidateAll race, the keyed
		// `{#each (c.id)}` saw a duplicate key, and Svelte 5 aborted the render
		// — detaching the sidebar `<a>` tags and silently breaking SPA link
		// clicks.
		const optimistic = conv('a', now);
		const server = conv('a', now - 1);
		const merged = mergeOptimisticConversations([optimistic], [server], new Set());
		expect(merged).toHaveLength(1);
		expect(merged[0]).toBe(server);
	});

	it('returns the server list unchanged when there are no optimistic rows', () => {
		const a = conv('a', now);
		const b = conv('b', now - 100);
		const merged = mergeOptimisticConversations([], [a, b], new Set());
		expect(merged).toEqual([a, b]);
	});

	it('filters archived ids even when only present optimistically', () => {
		const optimistic = conv('a', now);
		const merged = mergeOptimisticConversations([optimistic], [], new Set(['a']));
		expect(merged).toEqual([]);
	});

	it('keeps optimistic-only ids that have not yet appeared on the server', () => {
		const optimistic = conv('a', now);
		const server = conv('b', now - 100);
		const merged = mergeOptimisticConversations([optimistic], [server], new Set());
		expect(merged).toEqual([optimistic, server]);
	});

	it('orders optimistic-only rows ahead of server rows', () => {
		const opt1 = conv('opt1', now);
		const opt2 = conv('opt2', now);
		const srv1 = conv('srv1', now - 100);
		const merged = mergeOptimisticConversations([opt1, opt2], [srv1], new Set());
		expect(merged.map((c) => c.id)).toEqual(['opt1', 'opt2', 'srv1']);
	});
});
