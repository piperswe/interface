import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_LIST, parseModelList, serializeModelList } from './config';

describe('parseModelList', () => {
	it('returns the defaults for null/empty input', () => {
		expect(parseModelList(null)).toEqual(DEFAULT_MODEL_LIST);
		expect(parseModelList('')).toEqual(DEFAULT_MODEL_LIST);
		expect(parseModelList('   \n  ')).toEqual(DEFAULT_MODEL_LIST);
	});
	it('parses pipe-delimited slug|label pairs', () => {
		const out = parseModelList('foo/bar|Foo Bar\nx/y|XY');
		expect(out).toEqual([
			{ slug: 'foo/bar', label: 'Foo Bar' },
			{ slug: 'x/y', label: 'XY' },
		]);
	});
	it('treats slug-only lines as label = slug', () => {
		expect(parseModelList('foo/bar')).toEqual([{ slug: 'foo/bar', label: 'foo/bar' }]);
	});
	it('skips comments and blank lines', () => {
		const out = parseModelList('# header\n\nfoo|Foo\n\n# trailing');
		expect(out).toEqual([{ slug: 'foo', label: 'Foo' }]);
	});
	it('trims surrounding whitespace on slug and label', () => {
		const out = parseModelList('  foo  |  Foo  ');
		expect(out).toEqual([{ slug: 'foo', label: 'Foo' }]);
	});
	it('returns defaults when every line is filtered out', () => {
		expect(parseModelList('# only comments\n# nothing\n')).toEqual(DEFAULT_MODEL_LIST);
	});
});

describe('serializeModelList', () => {
	it('round-trips with parseModelList for the defaults', () => {
		expect(parseModelList(serializeModelList(DEFAULT_MODEL_LIST))).toEqual(DEFAULT_MODEL_LIST);
	});
	it('joins each entry with a pipe', () => {
		expect(
			serializeModelList([
				{ slug: 'a', label: 'A' },
				{ slug: 'b', label: 'B' },
			]),
		).toBe('a|A\nb|B');
	});
	it('returns empty string for empty list', () => {
		expect(serializeModelList([])).toBe('');
	});
});
