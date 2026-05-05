import { describe, expect, it } from 'vitest';
import { computeNextRunAt } from './schedules';

// Anchor: Monday 2026-05-04 12:34 UTC (a recognisable mid-week mid-day time).
const MONDAY_NOON = Date.UTC(2026, 4, 4, 12, 34, 0);

describe('computeNextRunAt', () => {
	it('hourly: rolls forward to the top of the next hour', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'hourly', null, null);
		expect(new Date(next).toISOString()).toBe('2026-05-04T13:00:00.000Z');
	});

	it('daily: same day if the time of day is still ahead', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'daily', 18 * 60, null);
		expect(new Date(next).toISOString()).toBe('2026-05-04T18:00:00.000Z');
	});

	it('daily: next day if the time of day already passed', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'daily', 8 * 60, null);
		expect(new Date(next).toISOString()).toBe('2026-05-05T08:00:00.000Z');
	});

	it('weekly: same day later if the matching weekday hasn\'t reached its time yet', () => {
		// Monday is dayOfWeek=1. 18:00 UTC is later than 12:34 UTC.
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 18 * 60, 1);
		expect(new Date(next).toISOString()).toBe('2026-05-04T18:00:00.000Z');
	});

	it('weekly: rolls a full week forward if both day and time already passed', () => {
		// Monday earlier in the day → next Monday.
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 8 * 60, 1);
		expect(new Date(next).toISOString()).toBe('2026-05-11T08:00:00.000Z');
	});

	it('weekly: rolls forward to a later weekday', () => {
		// Friday = 5
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 9 * 60, 5);
		expect(new Date(next).toISOString()).toBe('2026-05-08T09:00:00.000Z');
	});

	it('weekly: wraps Sunday correctly', () => {
		const next = computeNextRunAt(MONDAY_NOON, 'weekly', 9 * 60, 0);
		expect(new Date(next).toISOString()).toBe('2026-05-10T09:00:00.000Z');
	});
});
