import { error } from '@sveltejs/kit';
import { getConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { getModelList } from '$lib/server/settings';
import { renderArtifactCode, renderMarkdown } from '$lib/server/markdown';
import type { Artifact, ConversationState, MessagePart, MessageRow } from '$lib/types/conversation';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { PageServerLoad } from './$types';

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

async function withRenderedMarkdown(state: ConversationState): Promise<ConversationState> {
	const messages: MessageRow[] = await Promise.all(
		state.messages.map(async (m) => {
			const artifacts = m.artifacts
				? await Promise.all(m.artifacts.map(async (a) => ({ ...a, contentHtml: await renderArtifactHtml(a) })))
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
	return { ...state, messages };
}

export const load: PageServerLoad = async ({ params, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const stub = getConversationStub(platform.env, conversationId);
	const [state, models, conversation] = await Promise.all([
		stub.getState(),
		getModelList(platform.env),
		getConversation(platform.env, conversationId),
	]);
	if (!conversation) error(404, 'not found');

	return {
		conversation,
		models,
		thinkingBudget: conversation.thinking_budget ?? null,
		initialState: await withRenderedMarkdown(state),
	};
};
