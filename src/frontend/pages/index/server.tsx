import { renderToReadableStream } from 'react-dom/server';

const css = `
	body {font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
	form {display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
	select {padding: 0.5rem; font-size: 1rem; }
	input {flex: 1; min-width: 12rem; padding: 0.5rem; font-size: 1rem; }
	button {padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
	#output {white-space: pre-wrap; border: 1px solid #ccc; padding: 1rem; min-height: 8rem; border-radius: 6px; }
	#meta {margin-top: 1rem; border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem 1rem; background: #fafafa; font-size: 0.9rem; display: none; }
	#meta h2 {margin: 0 0 0.5rem; font-size: 1rem; }
	#meta dl {display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0; }
	#meta dt {color: #666; }
	#meta dd {margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
`;

export function IndexPage({ models }: { models: string[] }) {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<title>Chat</title>
				<style>{css}</style>
			</head>
			<body>
				<h1>Chat</h1>
				<form id="form">
					<select id="model" name="model">
						$
						{models.map((model) => (
							<option value={model}>{model}</option>
						))}
					</select>
					<input id="question" type="text" placeholder="Ask a question..." autoComplete="off" required />
					<button id="go" type="submit">
						Ask
					</button>
				</form>
				<div id="output"></div>
				<div id="meta"></div>
				<script src="/dist/index.js"></script>
			</body>
		</html>
	);
}

export async function renderIndexPage(models: string[]): Promise<ReadableStream> {
	const el = <IndexPage models={models} />;
	return await renderToReadableStream(el);
}
