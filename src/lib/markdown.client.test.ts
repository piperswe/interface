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

	it('highlights fenced code blocks with shiki', async () => {
		const html = await renderMarkdownClient('```ts\nconst x = 1;\n```');
		expect(html).toContain('shiki');
		expect(html).toContain('github-dark');
		expect(html).toContain('const');
	});

	it('falls back to plain rendering for unknown languages', async () => {
		const html = await renderMarkdownClient('```nonsense\nfoo bar\n```');
		expect(html).toContain('foo bar');
	});

	// Raw HTML passes through so that extensions (KaTeX) can emit markup.
	// XSS protection is the responsibility of the output layer (CSP / DOMPurify).
	it('passes raw HTML through (extensions need this)', async () => {
		const html = await renderMarkdownClient('<b>hello</b>');
		expect(html).toContain('<b>hello</b>');
	});

	it('renders inline LaTeX with KaTeX', async () => {
		const html = await renderMarkdownClient('Pythagoras: $a^2 + b^2 = c^2$.');
		expect(html).toContain('katex');
	});

	it('renders block LaTeX with KaTeX', async () => {
		const html = await renderMarkdownClient('$$\\int_0^1 x\\,dx$$');
		expect(html).toContain('katex-display');
	});

	it('renders inline LaTeX with \\( \\) delimiters', async () => {
		const html = await renderMarkdownClient('Pythagoras: \\(a^2 + b^2 = c^2\\).');
		expect(html).toContain('katex');
	});

	it('renders block LaTeX with \\[ \\] delimiters', async () => {
		const html = await renderMarkdownClient('\\[\\int_0^1 x\\,dx\\]');
		expect(html).toContain('katex-display');
	});

	it('preserves GFM tables', async () => {
		const html = await renderMarkdownClient('| a | b |\n|---|---|\n| 1 | 2 |');
		expect(html).toContain('<table');
		expect(html).toContain('<th>a</th>');
	});
});
