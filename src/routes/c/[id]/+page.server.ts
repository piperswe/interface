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
		if (typeof part.textHtml === 'string' && part.textHtml.length > 0) return part;
		return { ...part, textHtml: await renderMarkdown(part.text) };
	}
	return part;
}

async function withRenderedMarkdown(state: ConversationState): Promise<ConversationState> {
	// Re-render only what the DO didn't already render. The DO writes HTML at
	// generation completion (and on user-message insert / artifact add); for
	// rows that pre-date that — and for in-flight assistant rows — we render
	// here. This keeps repeated page loads on a finished conversation cheap.
	const messages: MessageRow[] = await Promise.all(
		state.messages.map(async (m) => {
			const artifacts = m.artifacts
				? await Promise.all(
						m.artifacts.map(async (a) =>
							typeof a.contentHtml === 'string' && a.contentHtml.length > 0
								? a
								: { ...a, contentHtml: await renderArtifactHtml(a) },
						),
					)
				: m.artifacts;
			const thinkingHtml =
				typeof m.thinkingHtml === 'string' && m.thinkingHtml.length > 0
					? m.thinkingHtml
					: m.thinking
						? await renderMarkdown(m.thinking)
						: null;
			const contentHtml =
				typeof m.contentHtml === 'string' && m.contentHtml.length > 0
					? m.contentHtml
					: m.content
						? await renderMarkdown(m.content)
						: m.contentHtml ?? null;
			if (m.role === 'user') {
				return { ...m, contentHtml, thinkingHtml, artifacts };
			}
			if (m.status !== 'complete') {
				return { ...m, thinkingHtml, artifacts };
			}
			const parts = m.parts ? await Promise.all(m.parts.map(renderPartHtml)) : m.parts;
			return { ...m, contentHtml, thinkingHtml, artifacts, parts };
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
