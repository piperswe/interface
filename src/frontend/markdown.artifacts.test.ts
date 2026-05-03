import { describe, expect, it } from 'vitest';
import { renderArtifactCode } from './markdown';

describe('renderArtifactCode', () => {
	it('returns empty for empty input', async () => {
		expect(await renderArtifactCode('', 'typescript')).toBe('');
	});

	it('highlights code with the requested language', async () => {
		const html = await renderArtifactCode('const x: number = 1;', 'typescript');
		expect(html).toContain('shiki');
		expect(html).toContain('github-dark');
	});

	it('falls back to plain text for unknown languages', async () => {
		const html = await renderArtifactCode('foo bar', 'totally-fake-lang');
		expect(html).toContain('foo bar');
	});
});
