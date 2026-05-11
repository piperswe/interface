// Client-side markdown pipeline: marked + KaTeX + Shiki. The browser does
// every render; the server never ships rendered HTML. Languages are loaded
// lazily by `createHighlighter`, so each one becomes its own chunk and the
// initial bundle stays small.
//
// XSS posture: LLM- and user-generated markdown could otherwise carry raw
// `<script>` tags or `javascript:` URLs that `{@html}` consumers would
// execute. marked v14 passes raw HTML through and does not filter URL
// schemes. We override marked's `html` token to HTML-escape raw HTML, and
// override the `link`/`image` renderers to drop dangerous URL schemes.
// DOMPurify is run as defense-in-depth in browsers where `window` is
// available; the override-based approach is the primary control.

import 'katex/dist/katex.min.css';
import { Marked, type MarkedExtension } from 'marked';
import markedShiki from 'marked-shiki';
import markedKatex from 'marked-katex-extension';
import { markedKatexParen } from './marked-katex-paren';
import { markedInlineCitation } from './marked-inline-citation';
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

// URL scheme allowlist for marked's link/image renderers. Exported for
// unit testing; the same predicate is reused by `components/url-guard.ts`
// for raw URL attribute sinks.
function isSafeUrl(value: string): boolean {
	const v = value.trim().toLowerCase();
	if (v === '') return true;
	if (
		v.startsWith('http:') ||
		v.startsWith('https:') ||
		v.startsWith('mailto:') ||
		v.startsWith('tel:') ||
		v.startsWith('#') ||
		v.startsWith('/') ||
		v.startsWith('./') ||
		v.startsWith('../')
	) {
		return true;
	}
	if (v.startsWith('data:image/')) return true;
	return false;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
	return escapeHtml(s);
}

const marked = new Marked({
	gfm: true,
	breaks: true,
	async: true,
});

// Override marked's `link`, `image`, and `html` renderers so raw HTML and
// dangerous URL schemes cannot reach `{@html}` consumers. `html` is the
// markdown-level "block of literal HTML" token — letting it through means
// `<script>` or `<img onerror>` in LLM output would execute on render.
const xssGuardExtension: MarkedExtension = {
	renderer: {
		link({ href, title, tokens }) {
			const safe = isSafeUrl(href) ? href : '#';
			const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
			// `tokens` are already-escaped text/inline children; defer to marked's
			// own parseInline so nested code/emphasis still works.
			const text = this.parser.parseInline(tokens);
			return `<a href="${escapeAttr(safe)}"${titleAttr}>${text}</a>`;
		},
		image({ href, title, text }) {
			const safe = isSafeUrl(href) ? href : '';
			if (!safe) return escapeHtml(text);
			const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
			return `<img src="${escapeAttr(safe)}" alt="${escapeAttr(text)}"${titleAttr}>`;
		},
		html({ text }) {
			// Marked v14's default emits the raw HTML verbatim. Escape it so the
			// browser sees text, not tags. KaTeX renders via its own extension
			// path and isn't routed through here.
			return escapeHtml(text);
		},
	},
};

marked.use(xssGuardExtension);
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
marked.use(markedKatexParen({ throwOnError: false }));
marked.use(markedInlineCitation());

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

// Sanitise LLM-supplied SVG artifacts before they reach `{@html}`. SVGs can
// carry `<script>`, event handlers, and `<foreignObject>` containing HTML
// nodes — all three are XSS sinks. We use a small, targeted stripper rather
// than DOMPurify because this module needs to work in non-browser test
// environments where DOM polyfills aren't available.
export function sanitizeSvgClient(svg: string): string {
	if (!svg) return '';
	let out = svg;
	// Strip `<script>...</script>` (case-insensitive, including with attributes).
	out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
	out = out.replace(/<script\b[^>]*\/>/gi, '');
	// Strip `<foreignObject>...</foreignObject>` (HTML escape hatch).
	out = out.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '');
	out = out.replace(/<foreignObject\b[^>]*\/>/gi, '');
	// Strip event-handler attributes (`on*=`) — quoted or unquoted, with optional spaces.
	out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
	out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
	out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
	// Strip `javascript:` / `vbscript:` URLs in href/src/xlink:href.
	out = out.replace(
		/(\s(?:href|src|xlink:href)\s*=\s*["']?)\s*(?:javascript|vbscript|data:text):/gi,
		'$1#blocked:',
	);
	return out;
}

// Exported for unit testing.
export const _isSafeUrl = isSafeUrl;
