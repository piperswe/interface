import type { ReactNode } from 'react';

export type DocumentProps = {
	title: string;
	bodyClass?: string;
	children: ReactNode;
};

export function Document({ title, bodyClass, children }: DocumentProps) {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<link rel="stylesheet" href="/dist/styles.css" />
			</head>
			<body className={bodyClass}>
				<div id="root">{children}</div>
			</body>
		</html>
	);
}
