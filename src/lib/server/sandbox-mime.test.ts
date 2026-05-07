import { describe, expect, it } from 'vitest';
import { DEFAULT_BINARY_MIME, mimeTypeForPath } from './sandbox-mime';

describe('mimeTypeForPath', () => {
	it('looks up by full path with extension', () => {
		expect(mimeTypeForPath('/workspace/foo.png')).toBe('image/png');
		expect(mimeTypeForPath('foo/bar.json')).toBe('application/json');
	});

	it('handles bare extensions', () => {
		expect(mimeTypeForPath('md')).toBe('text/markdown');
		expect(mimeTypeForPath('SVG')).toBe('image/svg+xml');
	});

	it('is case-insensitive on the extension', () => {
		expect(mimeTypeForPath('/x/Foo.PNG')).toBe('image/png');
	});

	it('returns the binary fallback for unknown extensions', () => {
		expect(mimeTypeForPath('foo.unknownext')).toBe(DEFAULT_BINARY_MIME);
		expect(mimeTypeForPath('')).toBe(DEFAULT_BINARY_MIME);
	});

	it('returns the binary fallback when no extension is present in a path', () => {
		// Path has a dot in a directory but the basename has no extension.
		expect(mimeTypeForPath('foo')).toBe(DEFAULT_BINARY_MIME);
	});
});
