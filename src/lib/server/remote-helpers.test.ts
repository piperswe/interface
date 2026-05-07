import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../../test/shims/app-server';
import { formString, formTrim, getEnv, parseFormId, safeRedirectTo } from './remote-helpers';

afterEach(() => {
	clearMockRequestEvent();
});

describe('getEnv', () => {
	it('returns platform.env when present', () => {
		const env = { DB: 'fake-db' } as unknown as Env;
		setMockRequestEvent({ platform: { env } });
		expect(getEnv()).toBe(env);
	});

	it('throws 500 when platform bindings are missing', () => {
		setMockRequestEvent({ platform: undefined });
		try {
			getEnv();
			throw new Error('expected throw');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(500);
		}
	});
});

describe('formString / formTrim', () => {
	it('coerces null/undefined to empty string', () => {
		expect(formString(null)).toBe('');
		expect(formString(undefined)).toBe('');
	});

	it('passes strings through', () => {
		expect(formString('hello')).toBe('hello');
		expect(formTrim('  hi  ')).toBe('hi');
	});

	it('coerces non-string values to their string form', () => {
		expect(formString(42)).toBe('42');
		expect(formString(true)).toBe('true');
	});
});

describe('parseFormId', () => {
	beforeEach(() => {
		setMockRequestEvent({ platform: { env: {} as unknown as Env } });
	});

	it('parses a positive integer', () => {
		expect(parseFormId('42')).toBe(42);
		expect(parseFormId(7)).toBe(7);
	});

	it('throws 400 for empty / missing', () => {
		try {
			parseFormId(undefined);
			throw new Error('expected throw');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
			if (isHttpError(e)) expect(e.status).toBe(400);
		}
	});

	it('throws 400 for non-numeric', () => {
		try {
			parseFormId('abc');
			throw new Error('expected throw');
		} catch (e) {
			expect(isHttpError(e)).toBe(true);
		}
	});

	it('throws 400 for zero or negative', () => {
		for (const bad of [0, -1, '0', '-7']) {
			try {
				parseFormId(bad);
				throw new Error(`expected throw for ${bad}`);
			} catch (e) {
				expect(isHttpError(e)).toBe(true);
			}
		}
	});

	it('uses the supplied label in the error', () => {
		try {
			parseFormId('', 'tag id');
			throw new Error('expected throw');
		} catch (e) {
			if (!isHttpError(e)) throw e;
			expect(String(e.body.message)).toMatch(/tag id/);
		}
	});
});

describe('safeRedirectTo', () => {
	it('passes same-origin paths through', () => {
		expect(safeRedirectTo('/settings', '/')).toBe('/settings');
		expect(safeRedirectTo('/c/abc-123', '/')).toBe('/c/abc-123');
	});

	it('rejects protocol-relative URLs', () => {
		expect(safeRedirectTo('//evil.example.com', '/')).toBe('/');
		expect(safeRedirectTo('/\\evil.example.com', '/')).toBe('/');
	});

	it('rejects absolute URLs', () => {
		expect(safeRedirectTo('https://evil.example.com', '/')).toBe('/');
	});

	it('falls back when the value is missing', () => {
		expect(safeRedirectTo(undefined, '/settings')).toBe('/settings');
		expect(safeRedirectTo(null, '/settings')).toBe('/settings');
	});
});
