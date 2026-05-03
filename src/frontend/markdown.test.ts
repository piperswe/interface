import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
	it('returns empty string for empty input', async () => {
		expect(await renderMarkdown('')).toBe('');
	});

	it('renders basic markdown', async () => {
		const html = await renderMarkdown('# Hello');
		expect(html).toContain('<h1>Hello</h1>');
	});

	it('escapes raw HTML in markdown', async () => {
		const html = await renderMarkdown('<script>alert(1)</script>');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('highlights fenced code with shiki', async () => {
		const html = await renderMarkdown('```ts\nconst x: number = 1;\n```');
		expect(html).toContain('shiki');
		expect(html).toContain('github-dark');
	});

	it('falls back to plain rendering for unknown languages', async () => {
		const html = await renderMarkdown('```nonsense\nfoo bar\n```');
		expect(html).toContain('foo bar');
	});

	it('renders inline LaTeX with KaTeX', async () => {
		const html = await renderMarkdown('Pythagoras: $a^2 + b^2 = c^2$ done.');
		expect(html).toContain('katex');
		expect(html).toContain('a');
	});

	it('renders block LaTeX with KaTeX', async () => {
		const html = await renderMarkdown('$$\\int_0^1 x\\,dx$$');
		expect(html).toContain('katex-display');
	});

	it('does not throw on malformed LaTeX', async () => {
		const html = await renderMarkdown('$$\\unknown_macro$$');
		expect(typeof html).toBe('string');
	});

	it('preserves GFM tables', async () => {
		const html = await renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
		expect(html).toContain('<table');
		expect(html).toContain('<th>a</th>');
	});
});
