import { describe, expect, it } from 'vitest';
import { _ftsQueryForTest } from './search';

describe('search query builder', () => {
	it('returns an empty string for empty input', () => {
		expect(_ftsQueryForTest('')).toBe('');
		expect(_ftsQueryForTest('   ')).toBe('');
	});

	it('wraps single tokens in double quotes', () => {
		expect(_ftsQueryForTest('hello')).toBe('"hello"');
	});

	it('joins multiple tokens with whitespace (FTS5 implicit AND)', () => {
		expect(_ftsQueryForTest('hello world')).toBe('"hello" "world"');
	});

	it('escapes embedded double-quotes by doubling them', () => {
		expect(_ftsQueryForTest('say "hi"')).toBe('"say" """hi"""');
	});

	it('strips FTS5 operators by quoting them', () => {
		// Without escaping, "AND" would be parsed as the FTS5 operator. Quoting
		// turns it into a literal token and the operator interpretation is gone.
		expect(_ftsQueryForTest('cats AND dogs')).toBe('"cats" "AND" "dogs"');
	});
});
