import { describe, expect, it } from 'vitest';
import {
	renderMarkdownClient,
	renderArtifactCodeClient,
	sanitizeSvgClient,
	_isSafeUrl,
} from './markdown.client';
void renderArtifactCodeClient;

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

	// Regression (C1): marked v14 passes raw HTML through, and the output
	// reached `{@html}` consumers without sanitisation. We now escape raw
	// HTML at the markdown layer so script tags, event handlers, and
	// dangerous URL schemes can't reach the DOM. Users wanting bold should
	// use markdown syntax (`**bold**`) instead of `<b>`.
	it('escapes raw HTML tags (including benign ones)', async () => {
		const html = await renderMarkdownClient('<b>hello</b>');
		expect(html).not.toContain('<b>hello</b>');
		expect(html).toContain('&lt;b&gt;hello&lt;/b&gt;');
	});

	it('still renders markdown bold (**) as <strong>', async () => {
		const html = await renderMarkdownClient('**hello**');
		expect(html).toContain('<strong>hello</strong>');
	});

	it('escapes <script> tags from markdown source', async () => {
		// Raw HTML is escaped, not stripped, so the user can see what they typed.
		// The script never executes because the browser sees `&lt;script&gt;`
		// as text rather than a tag.
		const html = await renderMarkdownClient('Hello <script>alert(1)</script> world');
		expect(html).not.toMatch(/<script\b/i);
		expect(html).toContain('&lt;script&gt;');
	});

	it('escapes event handler attributes (no executable <img> tag)', async () => {
		const html = await renderMarkdownClient('<img src="x" onerror="alert(1)">');
		// No live `<img>` tag — the browser displays the escaped source as text.
		expect(html).not.toMatch(/<img\s[^>]*onerror/i);
		expect(html).toContain('&lt;img');
	});

	it('strips javascript: links in markdown', async () => {
		const html = await renderMarkdownClient('[click](javascript:alert(1))');
		expect(html).not.toMatch(/javascript:/i);
	});

	it('strips javascript: in raw <a href>', async () => {
		const html = await renderMarkdownClient('<a href="javascript:alert(1)">x</a>');
		// Raw HTML in markdown is escaped, not parsed — the browser renders the
		// text "<a href=...>" rather than evaluating it. Verify no live <a> tag
		// reaches the DOM.
		expect(html).not.toMatch(/<a\s[^>]*href=["']javascript:/i);
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

describe('sanitizeSvgClient', () => {
	// Regression: SVG artifacts were previously rendered with raw `{@html}`,
	// executing any `<script>` or `onload` payload the LLM emitted.
	it('strips <script> from an SVG', () => {
		const out = sanitizeSvgClient('<svg><script>alert(1)</script><circle cx="5" cy="5" r="3"/></svg>');
		expect(out).not.toContain('<script');
		expect(out).toContain('circle');
	});

	it('strips event handlers on SVG nodes', () => {
		const out = sanitizeSvgClient('<svg onload="alert(1)"><circle onclick="alert(2)" /></svg>');
		expect(out).not.toMatch(/onload|onclick/i);
	});

	it('rejects <foreignObject> (HTML escape hatch)', () => {
		const out = sanitizeSvgClient(
			'<svg><foreignObject><script>alert(1)</script></foreignObject></svg>',
		);
		expect(out).not.toContain('<script');
		expect(out).not.toMatch(/foreignobject/i);
	});

	it('returns empty for empty input', () => {
		expect(sanitizeSvgClient('')).toBe('');
	});
});

describe('_isSafeUrl', () => {
	it('rejects javascript: and vbscript:', () => {
		expect(_isSafeUrl('javascript:alert(1)')).toBe(false);
		expect(_isSafeUrl('vbscript:msgbox(1)')).toBe(false);
	});
	it('rejects data:text/html but allows data:image/', () => {
		expect(_isSafeUrl('data:text/html,<script>')).toBe(false);
		expect(_isSafeUrl('data:image/png;base64,AAA')).toBe(true);
	});
	it('allows http(s), relative, anchor, mailto, tel', () => {
		expect(_isSafeUrl('http://x')).toBe(true);
		expect(_isSafeUrl('https://x')).toBe(true);
		expect(_isSafeUrl('#section')).toBe(true);
		expect(_isSafeUrl('/path')).toBe(true);
		expect(_isSafeUrl('mailto:x@y')).toBe(true);
		expect(_isSafeUrl('tel:+1')).toBe(true);
	});
});
