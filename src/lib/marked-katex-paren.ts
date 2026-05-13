import katex from 'katex';

function isUnescapedBackslash(src: string, i: number): boolean {
	return src[i] === '\\' && (i === 0 || src[i - 1] !== '\\');
}

function readInlineMath(src: string): { text: string; raw: string } | null {
	if (src[0] !== '\\' || src[1] !== '(') return null;
	let i = 2;
	while (i < src.length) {
		if (isUnescapedBackslash(src, i) && src[i + 1] === ')') {
			return { raw: src.slice(0, i + 2), text: src.slice(2, i) };
		}
		i++;
	}
	return null;
}

function readBlockMath(src: string): { text: string; raw: string } | null {
	if (src[0] !== '\\' || src[1] !== '[') return null;
	let i = 2;
	while (i < src.length) {
		if (isUnescapedBackslash(src, i) && src[i + 1] === ']') {
			return { raw: src.slice(0, i + 2), text: src.slice(2, i) };
		}
		i++;
	}
	return null;
}

export function markedKatexParen(options: { throwOnError?: boolean } = {}) {
	const renderer = (token: { text: string; displayMode: boolean }) => {
		try {
			return katex.renderToString(token.text, {
				...options,
				displayMode: token.displayMode,
			});
		} catch {
			return token.text;
		}
	};

	return {
		extensions: [
			{
				level: 'inline' as const,
				name: 'inlineParenKatex',
				renderer,
				start(src: string) {
					return src.indexOf('\\(');
				},
				tokenizer(src: string) {
					const match = readInlineMath(src);
					if (match) {
						return {
							displayMode: false,
							raw: match.raw,
							text: match.text.trim(),
							type: 'inlineParenKatex',
						};
					}
					return undefined;
				},
			},
			{
				level: 'block' as const,
				name: 'blockParenKatex',
				renderer,
				start(src: string) {
					return src.indexOf('\\[');
				},
				tokenizer(src: string) {
					const match = readBlockMath(src);
					if (match) {
						return {
							displayMode: true,
							raw: match.raw,
							text: match.text.trim(),
							type: 'blockParenKatex',
						};
					}
					return undefined;
				},
			},
		],
	};
}
