// Client-side markdown pipeline: marked + KaTeX + Shiki. The browser does
// every render; the server never ships rendered HTML. Languages are loaded
// lazily by `createHighlighter`, so each one becomes its own chunk and the
// initial bundle stays small.

import { Marked } from 'marked';
import markedShiki from 'marked-shiki';
import markedKatex from 'marked-katex-extension';
import { markedKatexParen } from './marked-katex-paren';
import {
	createHighlighter,
	type Highlighter,
	type BundledLanguage,
} from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

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

const marked = new Marked({
	gfm: true,
	breaks: true,
	async: true,
});

marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
marked.use(markedKatexParen({ throwOnError: false }));

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

export async function renderMarkdownClient(src: string): Promise<string> {
	if (!src) return '';
	return await marked.parse(src);
}

export async function renderArtifactCodeClient(code: string, lang: string): Promise<string> {
	if (!code) return '';
	const highlighter = await getHighlighter();
	const known = LANGS as readonly string[];
	const safeLang = known.includes(lang) ? (lang as BundledLanguage) : 'text';
	return highlighter.codeToHtml(code, { lang: safeLang, theme: THEME });
}
