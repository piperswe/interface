import { describe, expect, it } from 'vitest';
import {
	checkboxBoolean,
	conversationIdSchema,
	positiveIntFlexible,
	positiveIntFromString,
	safeRedirectPath,
	trimmedNonEmpty,
	trimmedOptionalOrNull,
} from './remote-schemas';

describe('conversationIdSchema', () => {
	it('accepts canonical UUIDs', () => {
		expect(
			conversationIdSchema.parse('a1b2c3d4-e5f6-7890-abcd-ef1234567890'),
		).toBeTruthy();
	});

	it('rejects non-UUID strings', () => {
		expect(conversationIdSchema.safeParse('not-a-uuid').success).toBe(false);
		expect(
			conversationIdSchema.safeParse('------------------------------------').success,
		).toBe(false);
	});
});

describe('positiveIntFromString', () => {
	it('coerces a numeric string', () => {
		expect(positiveIntFromString.parse('42')).toBe(42);
	});

	it('rejects empty, zero, negative, and non-integer', () => {
		expect(positiveIntFromString.safeParse('').success).toBe(false);
		expect(positiveIntFromString.safeParse('0').success).toBe(false);
		expect(positiveIntFromString.safeParse('-1').success).toBe(false);
		expect(positiveIntFromString.safeParse('1.5').success).toBe(false);
		expect(positiveIntFromString.safeParse('abc').success).toBe(false);
	});
});

describe('positiveIntFlexible', () => {
	it('accepts number and stringified number', () => {
		expect(positiveIntFlexible.parse(7)).toBe(7);
		expect(positiveIntFlexible.parse('7')).toBe(7);
	});

	it('rejects zero / negative', () => {
		expect(positiveIntFlexible.safeParse(0).success).toBe(false);
		expect(positiveIntFlexible.safeParse(-3).success).toBe(false);
	});
});

describe('safeRedirectPath', () => {
	const schema = safeRedirectPath('/fallback');

	it('passes through a benign same-origin path', () => {
		expect(schema.parse('/c/abc')).toBe('/c/abc');
		expect(schema.parse('/settings?tab=mcp')).toBe('/settings?tab=mcp');
	});

	it('falls back for protocol-relative and CRLF smuggling', () => {
		expect(schema.parse('//evil.example')).toBe('/fallback');
		expect(schema.parse('/\\evil.example')).toBe('/fallback');
		expect(schema.parse('/foo\r\nLocation: x')).toBe('/fallback');
	});

	it('falls back when missing entirely', () => {
		expect(schema.parse(undefined)).toBe('/fallback');
	});
});

describe('checkboxBoolean', () => {
	it.each([
		['on', true],
		['true', true],
		['1', true],
		['TRUE', true],
		['', false],
		['off', false],
		[undefined, false],
	])('parses %p as %p', (input, expected) => {
		expect(checkboxBoolean.parse(input)).toBe(expected);
	});
});

describe('trimmedNonEmpty', () => {
	const schema = trimmedNonEmpty('Name is required');

	it('trims and accepts non-empty strings', () => {
		expect(schema.parse('  hello  ')).toBe('hello');
	});

	it('rejects whitespace-only with the supplied message', () => {
		const r = schema.safeParse('   ');
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.issues[0].message).toBe('Name is required');
	});
});

describe('trimmedOptionalOrNull', () => {
	it('returns null for missing / blank input', () => {
		expect(trimmedOptionalOrNull.parse(undefined)).toBe(null);
		expect(trimmedOptionalOrNull.parse('')).toBe(null);
		expect(trimmedOptionalOrNull.parse('   ')).toBe(null);
	});

	it('returns trimmed value otherwise', () => {
		expect(trimmedOptionalOrNull.parse('  x  ')).toBe('x');
	});
});
