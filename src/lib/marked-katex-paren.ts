import katex from 'katex';

function isUnescapedBackslash(src: string, i: number): boolean {
	return src[i] === '\\' && (i === 0 || src[i - 1] !== '\\');
}

function readInlineMath(src: string): { text: string; raw: string } | null {
	if (src[0] !== '\\' || src[1] !== '(') return null;
	let i = 2;
	while (i < src.length) {
		if (isUnescapedBackslash(src, i) && src[i + 1] === ')') {
			return { text: src.slice(2, i), raw: src.slice(0, i + 2) };
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
			return { text: src.slice(2, i), raw: src.slice(0, i + 2) };
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
				name: 'inlineParenKatex',
				level: 'inline' as const,
				start(src: string) {
					return src.indexOf('\\(');
				},
				tokenizer(src: string) {
					const match = readInlineMath(src);
					if (match) {
						return {
							type: 'inlineParenKatex',
							raw: match.raw,
							text: match.text.trim(),
							displayMode: false,
						};
					}
					return undefined;
				},
				renderer,
			},
			{
				name: 'blockParenKatex',
				level: 'block' as const,
				start(src: string) {
					return src.indexOf('\\[');
				},
				tokenizer(src: string) {
					const match = readBlockMath(src);
					if (match) {
						return {
							type: 'blockParenKatex',
							raw: match.raw,
							text: match.text.trim(),
							displayMode: true,
						};
					}
					return undefined;
				},
				renderer,
			},
		],
	};
}
