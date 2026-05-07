import { Marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { markedInlineCitation } from './marked-inline-citation';

function build() {
	const m = new Marked({ async: false });
	m.use(markedInlineCitation());
	return m;
}

describe('markedInlineCitation', () => {
	it('renders [N] as a superscript link to the matching citation anchor', () => {
		const out = build().parse('Paris is the capital of France [1].') as string;
		expect(out).toContain('class="citation-ref"');
		expect(out).toContain('href="#cite-1"');
		expect(out).toContain('[1]');
	});

	it('handles consecutive markers like [1][3]', () => {
		const out = build().parse('Both agree [1][3].') as string;
		expect(out).toContain('href="#cite-1"');
		expect(out).toContain('href="#cite-3"');
	});

	// Regression: an early version greedily tokenized `[5](http://x)` as a
	// citation marker, leaving the `(http://x)` orphaned in the output. The
	// tokenizer now defers to marked's link tokenizer when the closer is
	// followed by `(`.
	it('does not swallow markdown link text that happens to be a number', () => {
		const out = build().parse('See [1](https://example.com) for details.') as string;
		expect(out).toContain('href="https://example.com"');
		// The link's anchor text should remain "1", not become a citation ref.
		expect(out).not.toContain('href="#cite-1"');
	});

	it('leaves footnote-style [^N] alone', () => {
		const out = build().parse('See [^1] for a note.') as string;
		expect(out).not.toContain('citation-ref');
		expect(out).toContain('[^1]');
	});

	it('skips implausibly large numbers (likely years, not citations)', () => {
		const out = build().parse('In [2024] something happened.') as string;
		expect(out).not.toContain('citation-ref');
		expect(out).toContain('[2024]');
	});

	it('skips zero', () => {
		const out = build().parse('Edge case [0] here.') as string;
		expect(out).not.toContain('citation-ref');
	});

	it('does not transform [N] inside fenced code blocks', () => {
		const out = build().parse('```\narr[1] = 2;\n```') as string;
		expect(out).not.toContain('citation-ref');
	});

	it('does not transform [N] inside inline code spans', () => {
		const out = build().parse('Use `arr[1]` to access.') as string;
		expect(out).not.toContain('citation-ref');
	});
});
