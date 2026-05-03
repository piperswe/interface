import type { ReactElement } from 'react';
import { renderToReadableStream } from 'react-dom/server';

export type RenderOptions = {
	bootstrapModules?: string[];
	bootstrapScriptContent?: string;
};

const DOCTYPE = new TextEncoder().encode('<!doctype html>');

function prependDoctype(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(DOCTYPE);
			reader = stream.getReader();
		},
		async pull(controller) {
			if (!reader) return;
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader?.cancel(reason);
		},
	});
}

export async function renderHtml(element: ReactElement, options: RenderOptions = {}): Promise<ReadableStream<Uint8Array>> {
	const stream = await renderToReadableStream(element, {
		bootstrapModules: options.bootstrapModules,
		bootstrapScriptContent: options.bootstrapScriptContent,
		onError(err) {
			console.error('SSR error:', err);
		},
	});
	return prependDoctype(stream);
}

export function serializeProps<T>(props: T): string {
	return JSON.stringify(props).replace(/</g, '\\u003c');
}
