import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Toast } from './toasts';
import { dismissToast, pushToast, toasts } from './toasts';

function snapshot(): Toast[] {
	let captured: Toast[] = [];
	const unsub = toasts.subscribe((arr) => {
		captured = arr;
	});
	unsub();
	return captured;
}

beforeEach(() => {
	// Drain anything left over from previous tests in the same file.
	for (const t of snapshot()) dismissToast(t.id);
});

afterEach(() => {
	vi.useRealTimers();
	for (const t of snapshot()) dismissToast(t.id);
});

describe('pushToast', () => {
	it('appends a success toast with a non-zero auto-incrementing id', () => {
		vi.useFakeTimers();
		const id = pushToast('saved');
		expect(id).toBeGreaterThan(0);
		const arr = snapshot();
		expect(arr).toHaveLength(1);
		expect(arr[0]).toMatchObject({ id, message: 'saved', type: 'success' });
	});

	it('honours a custom toast type', () => {
		vi.useFakeTimers();
		pushToast('boom', 'error');
		expect(snapshot()[0]?.type).toBe('error');
	});

	it('issues distinct, ascending ids for successive pushes', () => {
		vi.useFakeTimers();
		const id1 = pushToast('a');
		const id2 = pushToast('b');
		const id3 = pushToast('c');
		expect(id1).toBeLessThan(id2);
		expect(id2).toBeLessThan(id3);
		expect(new Set([id1, id2, id3]).size).toBe(3);
	});

	it('auto-dismisses after the default 3000 ms', () => {
		vi.useFakeTimers();
		pushToast('hi');
		expect(snapshot()).toHaveLength(1);
		vi.advanceTimersByTime(2999);
		expect(snapshot()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(snapshot()).toHaveLength(0);
	});

	it('auto-dismisses after a custom positive timeout', () => {
		vi.useFakeTimers();
		pushToast('hi', 'success', 500);
		vi.advanceTimersByTime(499);
		expect(snapshot()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(snapshot()).toHaveLength(0);
	});

	it('does NOT auto-dismiss when timeout <= 0', () => {
		vi.useFakeTimers();
		const id = pushToast('sticky', 'error', 0);
		vi.advanceTimersByTime(60_000);
		expect(snapshot().map((t) => t.id)).toContain(id);
		// Still dismissable manually.
		dismissToast(id);
		expect(snapshot()).toHaveLength(0);
	});

	it('preserves order across multiple toasts', () => {
		vi.useFakeTimers();
		const a = pushToast('a');
		const b = pushToast('b');
		const c = pushToast('c');
		expect(snapshot().map((t) => t.id)).toEqual([a, b, c]);
	});
});

describe('dismissToast', () => {
	it('removes only the named toast', () => {
		vi.useFakeTimers();
		const a = pushToast('a');
		const b = pushToast('b');
		const c = pushToast('c');
		dismissToast(b);
		expect(snapshot().map((t) => t.id)).toEqual([a, c]);
	});

	it('is a no-op for unknown ids', () => {
		vi.useFakeTimers();
		const id = pushToast('a');
		dismissToast(id + 99_999);
		expect(snapshot().map((t) => t.id)).toEqual([id]);
	});

	it('subscriber is notified on push and dismiss', () => {
		vi.useFakeTimers();
		const seen: number[] = [];
		const unsub = toasts.subscribe((arr) => seen.push(arr.length));
		// Initial subscribe fires synchronously with current value.
		expect(seen).toEqual([0]);
		const id = pushToast('x');
		expect(seen.at(-1)).toBe(1);
		dismissToast(id);
		expect(seen.at(-1)).toBe(0);
		unsub();
	});
});
