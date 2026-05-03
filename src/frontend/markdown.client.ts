// Lite client-side markdown pipeline used during streaming. Deliberately
// skips Shiki — `shiki/bundle/web` still ships every supported grammar and
// blows the bundle past 5MB. Code blocks render as plain dark `<pre>` blocks
// styled by `.content pre`. Once a turn completes the DO emits `refresh`, the
// page reloads, and the server-side pipeline re-renders with full
// Shiki highlighting.

import { Marked, Renderer } from 'marked';
import markedKatex from 'marked-katex-extension';

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => {
		switch (c) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			case "'":
				return '&#39;';
			default:
				return c;
		}
	});
}

const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text);
// Use the default fenced-code renderer — escapes content, wraps in `<pre><code>`.

const marked = new Marked({
	gfm: true,
	breaks: true,
	async: false,
	renderer,
});

marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

export async function renderMarkdownClient(src: string): Promise<string> {
	if (!src) return '';
	const out = marked.parse(src);
	return typeof out === 'string' ? out : await out;
}
