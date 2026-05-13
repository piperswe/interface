import { describe, expect, it } from 'vitest';
import { formatError, redactSecrets } from './errors';

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

	// Regression (F3): formatError was documented as "redacts API keys" but
	// did nothing. The function now strips Anthropic / OpenAI / OpenRouter
	// key shapes plus Authorization / api-key header values before truncation.
	it('redacts sk-ant- (Anthropic) keys', () => {
		expect(formatError(new Error('401 from sk-ant-api03-AbCdEf1234567890XyZ'))).not.toMatch(/sk-ant-api03-AbCdEf1234567890XyZ/);
		expect(formatError(new Error('401 from sk-ant-api03-AbCdEf1234567890XyZ'))).toMatch(/REDACTED/);
	});

	it('redacts sk- (OpenAI / OpenRouter) keys', () => {
		expect(formatError(new Error('401 sk-proj-AbCdEf1234567890XyZ'))).toMatch(/REDACTED/);
		expect(formatError(new Error('401 sk-or-AbCdEf1234567890XyZ'))).toMatch(/REDACTED/);
	});

	it('redacts Authorization: Bearer headers in JSON payloads', () => {
		const errObj = { headers: { authorization: 'Bearer abc123def456ghi789' } };
		const out = formatError(errObj);
		expect(out).not.toMatch(/abc123def456ghi789/);
		expect(out).toMatch(/REDACTED/);
	});

	it('redactSecrets is exported for use elsewhere', () => {
		expect(redactSecrets('Bearer abc123def456ghi789xyz')).toMatch(/REDACTED/);
	});

	// Regression: for capture-group-less patterns, `String.prototype.replace`
	// passes `(match, offset, string)` to the callback, so the second arg is
	// a number, not the captured prefix. The previous implementation treated
	// any truthy value as a prefix and concatenated it before `***REDACTED***`,
	// producing output like `"401 from 9***REDACTED***"` (where 9 is the
	// match offset). The fix typeof-checks the prefix arg.
	it('does not splice the match offset into the redacted output', () => {
		// Match starts at index 9 — a non-zero offset triggered the bug.
		const out = redactSecrets('401 from sk-ant-api03-AbCdEf1234567890XyZ end');
		expect(out).toBe('401 from ***REDACTED*** end');
		expect(out).not.toMatch(/\d\*\*\*REDACTED/);
	});

	it('preserves the captured prefix for capture-group patterns', () => {
		// `Bearer <token>` pattern has a capture group; the callback must
		// still emit `Bearer ***REDACTED***` rather than swallowing the
		// `Bearer ` prefix.
		const out = redactSecrets('Authorization: Bearer abc123def456ghi789');
		expect(out).toContain('Bearer ***REDACTED***');
		expect(out).not.toMatch(/abc123def456ghi789/);
	});
});
