import { describe, expect, it } from 'vitest';
import type { Conversation } from '$lib/types/conversation';
import { BAND_ORDER, groupByBand } from './sidebar';

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
