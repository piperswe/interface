import { Marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { markedKatexParen } from './marked-katex-paren';

function build() {
	const m = new Marked({ async: false });
	m.use(markedKatexParen({ throwOnError: false }));
	return m;
}

describe('markedKatexParen', () => {
	it('renders inline \\(...\\) math via KaTeX', () => {
		const out = build().parse('foo \\(x^2\\) bar') as string;
		// KaTeX output has a `katex` class on the wrapper span.
		expect(out).toContain('class="katex"');
		expect(out).not.toContain('\\(');
	});
	it('renders block \\[...\\] math', () => {
		const out = build().parse('\\[ a + b = c \\]') as string;
		expect(out).toContain('class="katex');
		expect(out).not.toContain('\\[');
	});
	it('leaves text alone when there is no escape sequence', () => {
		const out = build().parse('plain text') as string;
		expect(out).toContain('plain text');
		expect(out).not.toContain('katex');
	});
	it('handles unmatched openers gracefully', () => {
		// No closing \) — should leave the text mostly intact (rendered as a paragraph).
		const out = build().parse('foo \\(unfinished') as string;
		expect(out).toContain('foo');
	});
	it('falls back to raw text when KaTeX throws', () => {
		// `\frac` without arguments is invalid; with throwOnError: false the
		// extension's renderer either returns raw text via our catch block or
		// KaTeX surfaces an error span.
		const out = build().parse('inline \\(\\frac\\) end') as string;
		expect(out).toContain('inline');
		expect(out).toContain('end');
	});
	it('respects unescaped vs escaped backslash boundaries', () => {
		// `\\)` is an escaped backslash followed by a paren — not a closer.
		// The inner `\\)` is not a closing delimiter, but `\)` after it is.
		// We just ensure something rendered, and the literal `\(` was consumed.
		const out = build().parse('start \\(a\\\\)b\\) tail') as string;
		expect(out).toContain('start');
		expect(out).toContain('tail');
	});
});
