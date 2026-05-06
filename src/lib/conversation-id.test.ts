import { describe, expect, it } from 'vitest';
import { CONVERSATION_ID_PATTERN } from './conversation-id';

describe('CONVERSATION_ID_PATTERN', () => {
	it('accepts a canonical lowercase UUIDv4', () => {
		expect(CONVERSATION_ID_PATTERN.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
	});
	it('accepts every output of crypto.randomUUID()', () => {
		// crypto.randomUUID() is the canonical producer of conversation ids;
		// the validator must always recognise its own output.
		for (let i = 0; i < 64; i++) {
			const id = crypto.randomUUID();
			expect(CONVERSATION_ID_PATTERN.test(id)).toBe(true);
		}
	});
	it('rejects uppercase hex', () => {
		expect(CONVERSATION_ID_PATTERN.test('123E4567-E89B-12D3-A456-426614174000')).toBe(false);
	});
	it('rejects too-short and too-long ids', () => {
		expect(CONVERSATION_ID_PATTERN.test('abc')).toBe(false);
		expect(CONVERSATION_ID_PATTERN.test('123e4567-e89b-12d3-a456-4266141740000')).toBe(false);
		// 35 chars (one short on the final group)
		expect(CONVERSATION_ID_PATTERN.test('123e4567-e89b-12d3-a456-42661417400')).toBe(false);
	});
	it('rejects non-hex characters', () => {
		expect(CONVERSATION_ID_PATTERN.test('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false);
	});
	it('rejects empty string', () => {
		expect(CONVERSATION_ID_PATTERN.test('')).toBe(false);
	});

	// Regression: the pattern used to be `/^[0-9a-f-]{36}$/` which accepts
	// any 36-character string drawn from [0-9a-f-]. That allowed pathological
	// inputs like 36 dashes or 36 zeros to pass route-guard validation and
	// flow through to D1 lookups; it also defeated the intent of the
	// "rejects too-short and too-long" check, since anything *exactly* 36
	// chars long made it through regardless of structure.
	it('rejects 36 dashes (regression: pattern was too permissive)', () => {
		expect(CONVERSATION_ID_PATTERN.test('-'.repeat(36))).toBe(false);
	});
	it('rejects 36 zeros without the canonical dashes', () => {
		expect(CONVERSATION_ID_PATTERN.test('0'.repeat(36))).toBe(false);
	});
	it('rejects misplaced dashes in an otherwise-valid-length string', () => {
		// Same characters as a real UUID but dashes in the wrong slots.
		expect(CONVERSATION_ID_PATTERN.test('123e45-67e89b-12d3-a456-426614174000')).toBe(false);
		expect(CONVERSATION_ID_PATTERN.test('123e4567e89b-12d3--a456-4266141740-0')).toBe(false);
	});
	it('rejects ids with leading or trailing whitespace', () => {
		expect(CONVERSATION_ID_PATTERN.test(' 123e4567-e89b-12d3-a456-426614174000')).toBe(false);
		expect(CONVERSATION_ID_PATTERN.test('123e4567-e89b-12d3-a456-426614174000 ')).toBe(false);
	});
	it('rejects ids missing dashes entirely', () => {
		expect(CONVERSATION_ID_PATTERN.test('123e4567e89b12d3a456426614174000abcd')).toBe(false);
	});
});
