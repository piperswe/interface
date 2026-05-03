import { describe, expect, it } from 'vitest';
import { renderMarkdownClient } from './markdown.client';

describe('renderMarkdownClient', () => {
	it('returns empty for empty input', async () => {
		expect(await renderMarkdownClient('')).toBe('');
	});

	it('renders headers and paragraphs', async () => {
		const html = await renderMarkdownClient('# Hi\n\nA paragraph.');
		expect(html).toContain('<h1>Hi</h1>');
		expect(html).toContain('<p>A paragraph.</p>');
	});

	it('renders fenced code blocks as plain pre/code (Shiki happens server-side after refresh)', async () => {
		const html = await renderMarkdownClient('```ts\nconst x = 1;\n```');
		expect(html).toContain('<pre>');
		expect(html).toContain('<code');
		expect(html).toContain('const x = 1;');
		// No Shiki classes — that's the deliberate trade-off for bundle size.
		expect(html).not.toContain('shiki');
	});

	it('escapes raw HTML', async () => {
		const html = await renderMarkdownClient('<script>alert(1)</script>');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('renders inline LaTeX with KaTeX', async () => {
		const html = await renderMarkdownClient('Pythagoras: $a^2 + b^2 = c^2$.');
		expect(html).toContain('katex');
	});

	it('renders block LaTeX with KaTeX', async () => {
		const html = await renderMarkdownClient('$$\\int_0^1 x\\,dx$$');
		expect(html).toContain('katex-display');
	});

	it('preserves GFM tables', async () => {
		const html = await renderMarkdownClient('| a | b |\n|---|---|\n| 1 | 2 |');
		expect(html).toContain('<table');
		expect(html).toContain('<th>a</th>');
	});
});
