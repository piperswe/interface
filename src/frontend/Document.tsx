import type { ReactNode } from 'react';

export type Theme = 'system' | 'light' | 'dark';

export type DocumentProps = {
	title: string;
	bodyClass?: string;
	theme?: Theme;
	children: ReactNode;
};

export function Document({ title, bodyClass, theme = 'system', children }: DocumentProps) {
	const colorScheme = theme === 'system' ? 'light dark' : theme;
	return (
		<html lang="en" data-theme={theme}>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
				<meta name="color-scheme" content={colorScheme} />
				<title>{title}</title>
				<link rel="stylesheet" href="/dist/styles.css" />
				<link rel="stylesheet" href="/dist/katex.min.css" />
			</head>
			<body className={bodyClass}>
				<div id="root">{children}</div>
			</body>
		</html>
	);
}
