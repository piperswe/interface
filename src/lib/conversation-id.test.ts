import { describe, expect, it } from 'vitest';
import { CONVERSATION_ID_PATTERN } from './conversation-id';

describe('CONVERSATION_ID_PATTERN', () => {
	it('accepts a canonical lowercase UUIDv4', () => {
		expect(CONVERSATION_ID_PATTERN.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
	});
	it('rejects uppercase hex', () => {
		expect(CONVERSATION_ID_PATTERN.test('123E4567-E89B-12D3-A456-426614174000')).toBe(false);
	});
	it('rejects too-short and too-long ids', () => {
		expect(CONVERSATION_ID_PATTERN.test('abc')).toBe(false);
		expect(CONVERSATION_ID_PATTERN.test('123e4567-e89b-12d3-a456-4266141740000')).toBe(false);
	});
	it('rejects non-hex characters', () => {
		expect(CONVERSATION_ID_PATTERN.test('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false);
	});
	it('rejects empty string', () => {
		expect(CONVERSATION_ID_PATTERN.test('')).toBe(false);
	});
});
