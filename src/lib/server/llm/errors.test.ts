import { describe, expect, it } from 'vitest';
import { formatError } from './errors';

describe('formatError', () => {
	it('returns the message of an Error instance', () => {
		expect(formatError(new Error('boom'))).toBe('boom');
	});

	it('truncates Error messages to 500 characters', () => {
		const long = 'x'.repeat(1500);
		const out = formatError(new Error(long));
		expect(out).toHaveLength(500);
		expect(out).toBe('x'.repeat(500));
	});

	it('JSON-stringifies plain objects', () => {
		expect(formatError({ code: 1, message: 'err' })).toBe('{"code":1,"message":"err"}');
	});

	it('truncates JSON-stringified output to 500 characters', () => {
		const out = formatError({ msg: 'y'.repeat(1000) });
		expect(out).toHaveLength(500);
	});

	it('handles a circular object without throwing', () => {
		// JSON.stringify throws on cycles; the catch block falls through to
		// String(e), which yields '[object Object]'.
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;
		const out = formatError(obj);
		expect(out).toBe('[object Object]');
	});

	it('falls back to String() for primitives and non-Error / non-object values', () => {
		expect(formatError('plain string')).toBe('plain string');
		expect(formatError(42)).toBe('42');
		expect(formatError(true)).toBe('true');
		expect(formatError(null)).toBe('null');
		expect(formatError(undefined)).toBe('undefined');
	});

	it('falls back to String() for an Error with no message', () => {
		// `e.message` is empty; `e instanceof Error` is true but the guard
		// requires `e.message` to be truthy, so the function falls through
		// to JSON.stringify(e). Errors stringify to "{}".
		expect(formatError(new Error(''))).toBe('{}');
	});

	it('truncates oversized primitive String() outputs', () => {
		const big = 'q'.repeat(1500);
		expect(formatError(big)).toHaveLength(500);
	});
});
