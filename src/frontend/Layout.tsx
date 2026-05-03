import type { ReactNode } from 'react';

export type LayoutProps = {
	title: string;
	bodyClass?: string;
	bodyAttrs?: Record<string, string>;
	scriptSrc?: string;
	children: ReactNode;
};

export function Layout({ title, bodyClass, bodyAttrs, scriptSrc, children }: LayoutProps) {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<link rel="stylesheet" href="/dist/styles.css" />
			</head>
			<body className={bodyClass} {...bodyAttrs}>
				{children}
				{scriptSrc ? <script src={scriptSrc}></script> : null}
			</body>
		</html>
	);
}
