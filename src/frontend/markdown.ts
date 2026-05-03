import { Marked, Renderer } from 'marked';

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

const marked = new Marked({
	gfm: true,
	breaks: true,
	async: false,
	renderer,
});

export function renderMarkdown(src: string): string {
	if (!src) return '';
	return marked.parse(src) as string;
}
