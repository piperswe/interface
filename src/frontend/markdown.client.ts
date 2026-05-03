// Lite client-side markdown pipeline used during streaming. Deliberately
// skips Shiki — `shiki/bundle/web` still ships every supported grammar and
// blows the bundle past 5MB. Code blocks render as plain dark `<pre>` blocks
// styled by `.content pre`. Once a turn completes the DO emits `refresh`, the
// page reloads, and the server-side pipeline re-renders with full
// Shiki highlighting.

import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';

const marked = new Marked({
	gfm: true,
	breaks: true,
	async: false,
});

marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

export async function renderMarkdownClient(src: string): Promise<string> {
	if (!src) return '';
	const out = marked.parse(src);
	return typeof out === 'string' ? out : await out;
}
