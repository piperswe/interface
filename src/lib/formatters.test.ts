import { describe, expect, it } from 'vitest';
import {
	fmtCost,
	fmtMs,
	fmtNumber,
	fmtRelative,
	fmtThroughput,
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

describe('fmtCost', () => {
	it('formats numbers with 6-decimal precision and a leading $', () => {
		expect(fmtCost(0.0125)).toBe('$0.012500');
		expect(fmtCost(1)).toBe('$1.000000');
		expect(fmtCost(0)).toBe('$0.000000');
	});
	it('returns em dash for non-numbers', () => {
		expect(fmtCost(undefined)).toBe('—');
		expect(fmtCost('$5')).toBe('—');
	});
});

describe('fmtMs', () => {
	it('returns dash for zero or negative', () => {
		expect(fmtMs(0)).toBe('—');
		expect(fmtMs(-100)).toBe('—');
	});
	it('formats sub-second as ms', () => {
		expect(fmtMs(250)).toBe('250 ms');
		expect(fmtMs(999)).toBe('999 ms');
	});
	it('formats >= 1000ms as seconds with two decimals', () => {
		expect(fmtMs(1000)).toBe('1.00 s');
		expect(fmtMs(2456)).toBe('2.46 s');
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
});

describe('fmtRelative', () => {
	const now = 1_700_000_000_000;
	it('returns "just now" for fresh timestamps', () => {
		expect(fmtRelative(now - 30_000, now)).toBe('just now');
		expect(fmtRelative(now, now)).toBe('just now');
	});
	it('formats minutes', () => {
		expect(fmtRelative(now - 5 * 60_000, now)).toBe('5m ago');
	});
	it('formats hours', () => {
		expect(fmtRelative(now - 2 * 3_600_000, now)).toBe('2h ago');
	});
	it('formats days', () => {
		expect(fmtRelative(now - 4 * 86_400_000, now)).toBe('4d ago');
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
