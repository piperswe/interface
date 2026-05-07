import { afterEach, describe, expect, it } from 'vitest';
import { now, setClock, setUuidSource, uuid } from './clock';

afterEach(() => {
	// Restore the production singletons so a leaked override can't poison
	// later tests.
	setClock(null);
	setUuidSource(null);
});

describe('clock', () => {
	it('now() defaults to Date.now()', () => {
		const before = Date.now();
		const got = now();
		const after = Date.now();
		expect(got).toBeGreaterThanOrEqual(before);
		expect(got).toBeLessThanOrEqual(after);
	});

	it('setClock overrides now()', () => {
		setClock(() => 12345);
		expect(now()).toBe(12345);
	});

	it('setClock(null) restores Date.now()', () => {
		setClock(() => 0);
		expect(now()).toBe(0);
		setClock(null);
		expect(now()).toBeGreaterThan(0);
	});

	it('uuid() defaults to crypto.randomUUID()', () => {
		const a = uuid();
		const b = uuid();
		expect(a).not.toBe(b);
		// Loose v4 sanity check — eight hex digits, dash, ...
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('setUuidSource overrides uuid()', () => {
		const seq: string[] = ['id-1', 'id-2', 'id-3'];
		let i = 0;
		setUuidSource(() => seq[i++]);
		expect(uuid()).toBe('id-1');
		expect(uuid()).toBe('id-2');
		expect(uuid()).toBe('id-3');
	});

	it('setUuidSource(null) restores crypto.randomUUID()', () => {
		setUuidSource(() => 'pinned');
		expect(uuid()).toBe('pinned');
		setUuidSource(null);
		expect(uuid()).not.toBe('pinned');
	});
});
