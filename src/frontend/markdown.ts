import { Marked, Renderer } from 'marked';
import markedShiki from 'marked-shiki';
import markedKatex from 'marked-katex-extension';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// Languages bundled with the worker. Curated for the daily-driver workflow per
// PRD §7.1 P0.5 acceptance criteria. Add by expanding this list.
const LANGS: BundledLanguage[] = [
	'typescript',
	'javascript',
	'tsx',
	'jsx',
	'python',
	'rust',
	'sql',
	'bash',
	'shell',
	'json',
	'yaml',
	'markdown',
	'html',
	'css',
];

const THEME = 'github-dark';

let highlighterPromise: Promise<Highlighter> | undefined;
function getHighlighter(): Promise<Highlighter> {
	return (highlighterPromise ??= createHighlighter({
		themes: [THEME],
		langs: LANGS,
		engine: createJavaScriptRegexEngine(),
	}));
}

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
	async: true,
	renderer,
});

marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

marked.use(
	markedShiki({
		highlight: async (code, lang) => {
			const highlighter = await getHighlighter();
			const known = LANGS as readonly string[];
			const safeLang = known.includes(lang) ? (lang as BundledLanguage) : 'text';
			return highlighter.codeToHtml(code, { lang: safeLang, theme: THEME });
		},
	}),
);

export async function renderMarkdown(src: string): Promise<string> {
	if (!src) return '';
	return await marked.parse(src);
}

// Server-side syntax-highlight a code artifact using the same Shiki bundle
// configured for fenced code blocks in markdown.
export async function renderArtifactCode(code: string, lang: string): Promise<string> {
	if (!code) return '';
	const highlighter = await getHighlighter();
	const known = LANGS as readonly string[];
	const safeLang = known.includes(lang) ? (lang as BundledLanguage) : 'text';
	return highlighter.codeToHtml(code, { lang: safeLang, theme: THEME });
}
