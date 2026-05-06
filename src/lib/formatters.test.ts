import { describe, expect, it } from 'vitest';
import {
	fmtMs,
	fmtNumber,
	fmtRelative,
	fmtThroughput,
	fmtUsd,
	recencyBand,
	recencyBandLabel,
} from './formatters';

describe('fmtNumber', () => {
	it('formats integers with locale grouping', () => {
		expect(fmtNumber(1234567)).toBe((1234567).toLocaleString());
	});
	it('returns em dash for non-numbers', () => {
		expect(fmtNumber(undefined)).toBe('—');
		expect(fmtNumber(null)).toBe('—');
		expect(fmtNumber('42')).toBe('—');
		expect(fmtNumber(NaN)).toBe(NaN.toLocaleString());
	});
});

describe('fmtMs', () => {
	it('returns dash for zero or negative', () => {
		expect(fmtMs(0)).toBe('—');
		expect(fmtMs(-100)).toBe('—');
	});
	it('returns dash for NaN', () => {
		// `!ms` covers NaN since NaN is falsy under `!`.
		expect(fmtMs(NaN)).toBe('—');
	});
	it('formats sub-second as ms (no decimals)', () => {
		expect(fmtMs(1)).toBe('1 ms');
		expect(fmtMs(250)).toBe('250 ms');
		expect(fmtMs(999)).toBe('999 ms');
	});
	it('formats >= 1000ms as seconds with two decimals', () => {
		expect(fmtMs(1000)).toBe('1.00 s');
		expect(fmtMs(2456)).toBe('2.46 s');
		// Larger values.
		expect(fmtMs(60_000)).toBe('60.00 s');
	});
	it('rounds the seconds representation to 2dp (not truncates)', () => {
		// 1499 ms → 1.499 s → rounds to 1.50 s, not 1.49 s.
		expect(fmtMs(1499)).toBe('1.50 s');
	});
});

describe('fmtUsd', () => {
	it('formats zero as $0.00', () => {
		expect(fmtUsd(0)).toBe('$0.00');
	});
	it('uses 4 fractional digits below $1', () => {
		expect(fmtUsd(0.5)).toBe('$0.5000');
		expect(fmtUsd(0.1234)).toBe('$0.1234');
		expect(fmtUsd(0.9999)).toBe('$0.9999');
	});
	it('uses 2 fractional digits at or above $1', () => {
		expect(fmtUsd(1)).toBe('$1.00');
		expect(fmtUsd(12.345)).toBe('$12.35');
		expect(fmtUsd(1234.567)).toBe('$1234.57');
	});
	it('collapses tiny positive values below $0.0001 to "<$0.0001"', () => {
		expect(fmtUsd(0.00001)).toBe('<$0.0001');
		expect(fmtUsd(0.00009)).toBe('<$0.0001');
	});
	it('does not collapse values at exactly $0.0001', () => {
		// The boundary is `< 0.0001`, so the threshold value renders normally.
		expect(fmtUsd(0.0001)).toBe('$0.0001');
	});
	it('rounds to 4 digits at the boundary just above the collapse threshold', () => {
		// Just above 0.0001 still uses the 4-digit format.
		expect(fmtUsd(0.000123)).toBe('$0.0001');
	});
});

describe('fmtThroughput', () => {
	it('returns dash when either operand is missing/zero', () => {
		expect(fmtThroughput(undefined, 1000)).toBe('—');
		expect(fmtThroughput(100, 0)).toBe('—');
		expect(fmtThroughput(0, 1000)).toBe('—');
	});
	it('formats tokens per second with one decimal', () => {
		expect(fmtThroughput(120, 1000)).toBe('120.0 tok/s');
		expect(fmtThroughput(50, 2000)).toBe('25.0 tok/s');
	});
	it('rounds (not truncates) the throughput to one decimal', () => {
		// 75 tokens / 0.4s = 187.5 tok/s — exactly the rounding boundary.
		expect(fmtThroughput(75, 400)).toBe('187.5 tok/s');
		// 100 / 0.6s = 166.6666... → 166.7 tok/s
		expect(fmtThroughput(100, 600)).toBe('166.7 tok/s');
	});
});

describe('fmtRelative', () => {
	const now = 1_700_000_000_000;
	it('returns "just now" for fresh timestamps', () => {
		expect(fmtRelative(now - 30_000, now)).toBe('just now');
		expect(fmtRelative(now, now)).toBe('just now');
	});
	it('returns "just now" for future timestamps (negative diff)', () => {
		// `diff < 60_000` is true when diff is negative, so future stamps
		// fall back to "just now". This is a sensible default; pin it down.
		expect(fmtRelative(now + 30_000, now)).toBe('just now');
	});
	it('formats minutes', () => {
		expect(fmtRelative(now - 5 * 60_000, now)).toBe('5m ago');
		// 1m boundary — at exactly 60_000 ms diff we round down to 1m.
		expect(fmtRelative(now - 60_000, now)).toBe('1m ago');
	});
	it('floors minutes (does not round up)', () => {
		expect(fmtRelative(now - 119_000, now)).toBe('1m ago');
	});
	it('formats hours', () => {
		expect(fmtRelative(now - 2 * 3_600_000, now)).toBe('2h ago');
		// 1h boundary — at exactly 3,600,000 ms diff we get "1h ago".
		expect(fmtRelative(now - 3_600_000, now)).toBe('1h ago');
	});
	it('formats days', () => {
		expect(fmtRelative(now - 4 * 86_400_000, now)).toBe('4d ago');
		// 1d boundary
		expect(fmtRelative(now - 86_400_000, now)).toBe('1d ago');
	});
	it('uses Date.now() by default', () => {
		// We don't pass a `now` here; the default (Date.now()) should treat
		// a timestamp from the recent past as "just now".
		expect(fmtRelative(Date.now() - 1000)).toBe('just now');
	});
});

describe('recencyBand', () => {
	const now = 1_700_000_000_000;
	it('maps timestamps within the last day to "today"', () => {
		expect(recencyBand(now - 60 * 60_000, now)).toBe('today');
	});
	it('maps timestamps within the past week to "this-week"', () => {
		expect(recencyBand(now - 3 * 86_400_000, now)).toBe('this-week');
	});
	it('maps anything older to "earlier"', () => {
		expect(recencyBand(now - 30 * 86_400_000, now)).toBe('earlier');
	});
});

describe('recencyBandLabel', () => {
	it('maps band ids to display labels', () => {
		expect(recencyBandLabel('today')).toBe('Today');
		expect(recencyBandLabel('this-week')).toBe('This week');
		expect(recencyBandLabel('earlier')).toBe('Earlier');
	});
});
