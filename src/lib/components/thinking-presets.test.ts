import { describe, expect, it } from 'vitest';
import { THINKING_PRESETS, describeBudget, presetFor } from './thinking-presets';

describe('THINKING_PRESETS', () => {
	it('starts with Off and ascends through Max', () => {
		expect(THINKING_PRESETS[0]).toEqual({ id: 'off', label: 'Off', budget: null });
		expect(THINKING_PRESETS.at(-1)?.id).toBe('max');
		// Budgets (excluding Off) are strictly increasing.
		const budgets = THINKING_PRESETS.slice(1).map((p) => p.budget!);
		const sorted = [...budgets].sort((a, b) => a - b);
		expect(budgets).toEqual(sorted);
	});
	it('exposes unique ids', () => {
		const ids = THINKING_PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('presetFor', () => {
	it('returns Off for null/0/negative budgets', () => {
		expect(presetFor(null)?.id).toBe('off');
		expect(presetFor(0)?.id).toBe('off');
		expect(presetFor(-100)?.id).toBe('off');
	});
	it('returns the matching preset for an exact budget', () => {
		expect(presetFor(1024)?.id).toBe('low');
		expect(presetFor(4096)?.id).toBe('medium');
		expect(presetFor(16384)?.id).toBe('high');
		expect(presetFor(32768)?.id).toBe('extra-high');
		expect(presetFor(64000)?.id).toBe('max');
	});
	it('returns null for non-matching positive budgets (custom)', () => {
		expect(presetFor(1234)).toBeNull();
		expect(presetFor(100000)).toBeNull();
	});
});

describe('describeBudget', () => {
	it('uses the preset label when matched', () => {
		expect(describeBudget(null)).toBe('Off');
		expect(describeBudget(1024)).toBe('Low');
		expect(describeBudget(64000)).toBe('Max');
	});
	it('falls back to a localised token count for custom values', () => {
		expect(describeBudget(2500)).toBe('2,500 tok');
		expect(describeBudget(12345)).toBe('12,345 tok');
	});
});
