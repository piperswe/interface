import { describe, expect, it } from 'vitest';
import { BoundedMap, BoundedSet } from './bounded-cache';

describe('BoundedMap', () => {
	it('evicts the oldest entry once it exceeds maxSize', () => {
		const m = new BoundedMap<string, number>(2);
		m.set('a', 1);
		m.set('b', 2);
		m.set('c', 3);
		expect(m.has('a')).toBe(false);
		expect([...m.keys()]).toEqual(['b', 'c']);
	});

	it('re-setting an existing key at capacity does not evict another entry', () => {
		const m = new BoundedMap<string, number>(2);
		m.set('a', 1);
		m.set('b', 2);
		m.set('a', 99);
		expect(m.has('a')).toBe(true);
		expect(m.has('b')).toBe(true);
		expect(m.get('a')).toBe(99);
	});

	it('behaves like a plain Map below capacity', () => {
		const m = new BoundedMap<string, number>(10);
		m.set('a', 1);
		m.set('b', 2);
		expect(m.size).toBe(2);
		expect(m.get('b')).toBe(2);
	});
});

describe('BoundedSet', () => {
	it('evicts the oldest value once it exceeds maxSize', () => {
		const s = new BoundedSet<string>(2);
		s.add('a');
		s.add('b');
		s.add('c');
		expect(s.has('a')).toBe(false);
		expect([...s]).toEqual(['b', 'c']);
	});

	it('re-adding an existing value at capacity does not evict another value', () => {
		const s = new BoundedSet<string>(2);
		s.add('a');
		s.add('b');
		s.add('a');
		expect(s.has('a')).toBe(true);
		expect(s.has('b')).toBe(true);
		expect(s.size).toBe(2);
	});
});
