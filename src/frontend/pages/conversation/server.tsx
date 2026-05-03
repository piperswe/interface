import { Document, type Theme } from '../../Document';
import { renderHtml, serializeProps } from '../../render';
import { renderArtifactCode, renderMarkdown } from '../../markdown';
import type { Artifact } from '../../../types/conversation';
import { ConversationPage, type ConversationPageProps } from './Page';

async function renderArtifactHtml(a: Artifact): Promise<string> {
	if (a.type === 'code') return await renderArtifactCode(a.content, a.language ?? 'text');
	if (a.type === 'markdown') return await renderMarkdown(a.content);
	return '';
}

// Pre-render markdown for completed assistant messages server-side. Streaming
// or errored messages keep contentHtml null and render as plain text on the
// client; on completion the DO broadcasts `refresh` and the page reloads,
// giving us a freshly SSR'd response with full markdown.
async function withRenderedMarkdown(props: ConversationPageProps): Promise<ConversationPageProps> {
	const messages = await Promise.all(
		props.initialState.messages.map(async (m) => {
			const artifacts = m.artifacts
				? await Promise.all(
						m.artifacts.map(async (a) => ({ ...a, contentHtml: await renderArtifactHtml(a) })),
					)
				: m.artifacts;
			const thinkingHtml = m.thinking ? await renderMarkdown(m.thinking) : null;
			if (m.role !== 'assistant' || m.status !== 'complete') {
				return { ...m, thinkingHtml, artifacts };
			}
			const html = await renderMarkdown(m.content);
			return { ...m, contentHtml: html, thinkingHtml, artifacts };
		}),
	);
	return {
		...props,
		initialState: { ...props.initialState, messages },
	};
}

export async function renderConversationPage(
	props: ConversationPageProps,
	options: { theme?: Theme } = {},
): Promise<ReadableStream<Uint8Array>> {
	const enriched = await withRenderedMarkdown(props);
	return renderHtml(
		<Document title={enriched.conversation.title} bodyClass="conversation" theme={options.theme}>
			<ConversationPage {...enriched} />
		</Document>,
		{
			bootstrapModules: ['/dist/conversation.js'],
			bootstrapScriptContent: `window.__PROPS__=${serializeProps(enriched)};`,
		},
	);
}
