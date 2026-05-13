// Marked extension that turns `[N]` markers in assistant prose into
// superscript links to the conversation's Sources block. The agent learns
// the convention from the system prompt: tools that emit citations number
// each result in their tool-result text (`[1] Title …`), and the agent
// reuses those numbers inline immediately after the relevant claim.
//
// Defers to markdown link/footnote tokenizers when the marker is actually
// the start of `[N](url)` or `[^N]`, so existing markdown semantics are
// preserved.

export function markedInlineCitation() {
	return {
		extensions: [
			{
				level: 'inline' as const,
				name: 'inlineCitation',
				renderer(token: { number: number }) {
					const n = token.number;
					return `<sup class="citation-ref"><a href="#cite-${n}" data-citation="${n}">[${n}]</a></sup>`;
				},
				start(src: string) {
					const i = src.indexOf('[');
					return i === -1 ? undefined : i;
				},
				tokenizer(src: string) {
					const match = /^\[(\d+)\]/.exec(src);
					if (!match) return undefined;
					// Defer to the built-in link tokenizer for `[N](url)`.
					// Our extension runs before built-ins, so without this
					// peek we'd swallow the link's text and leave a dangling
					// `(url)` behind.
					if (src[match[0].length] === '(') return undefined;
					const n = Number(match[1]);
					// Out-of-range or zero indices won't match any Sources
					// entry; let the renderer still produce the marker so the
					// model's output isn't silently rewritten, but skip
					// numbers that look implausibly large (e.g. `[2024]` is
					// almost certainly a year, not a citation).
					if (n <= 0 || n > 99) return undefined;
					return {
						number: n,
						raw: match[0],
						type: 'inlineCitation',
					};
				},
			},
		],
	};
}
