import { Document, type Theme } from '../../Document';
import { AppShell } from '../../components/AppShell';
import { renderHtml, serializeProps } from '../../render';
import { renderArtifactCode, renderMarkdown } from '../../markdown';
import type { Artifact, Conversation, MessagePart } from '../../../types/conversation';
import { ConversationPage, type ConversationPageProps } from './Page';

async function renderArtifactHtml(a: Artifact): Promise<string> {
	if (a.type === 'code') return await renderArtifactCode(a.content, a.language ?? 'text');
	if (a.type === 'markdown') return await renderMarkdown(a.content);
	return '';
}

async function renderPartHtml(part: MessagePart): Promise<MessagePart> {
	if (part.type === 'text' || part.type === 'thinking') {
		return { ...part, textHtml: await renderMarkdown(part.text) };
	}
	return part;
}

async function withRenderedMarkdown(props: ConversationPageProps): Promise<ConversationPageProps> {
	const messages = await Promise.all(
		props.initialState.messages.map(async (m) => {
			const artifacts = m.artifacts
				? await Promise.all(
						m.artifacts.map(async (a) => ({ ...a, contentHtml: await renderArtifactHtml(a) })),
					)
				: m.artifacts;
			const thinkingHtml = m.thinking ? await renderMarkdown(m.thinking) : null;
			if (m.role === 'user') {
				const html = await renderMarkdown(m.content);
				return { ...m, contentHtml: html, thinkingHtml, artifacts };
			}
			if (m.status !== 'complete') {
				return { ...m, thinkingHtml, artifacts };
			}
			const html = await renderMarkdown(m.content);
			const parts = m.parts ? await Promise.all(m.parts.map(renderPartHtml)) : m.parts;
			return { ...m, contentHtml: html, thinkingHtml, artifacts, parts };
		}),
	);
	return {
		...props,
		initialState: { ...props.initialState, messages },
	};
}

export async function renderConversationPage(
	props: { conversation: ConversationPageProps['conversation']; models: ConversationPageProps['models']; initialState: ConversationPageProps['initialState']; thinkingBudget?: ConversationPageProps['thinkingBudget'] },
	options: { theme?: Theme; conversations: Conversation[] },
): Promise<ReadableStream<Uint8Array>> {
	const fullProps: ConversationPageProps = {
		...props,
		conversations: options.conversations,
	};
	const enriched = await withRenderedMarkdown(fullProps);
	return renderHtml(
		<Document title={enriched.conversation.title} theme={options.theme}>
			<AppShell conversations={options.conversations} activeConversationId={enriched.conversation.id}>
				<ConversationPage {...enriched} />
			</AppShell>
		</Document>,
		{
			bootstrapModules: ['/dist/conversation.js'],
			bootstrapScriptContent: `window.__PROPS__=${serializeProps(enriched)};`,
		},
	);
}
