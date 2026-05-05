import { error } from '@sveltejs/kit';
import { createConversation, getConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { listAllModels } from '$lib/server/providers/models';
import { getSetting } from '$lib/server/settings';
import { listStyles } from '$lib/server/styles';
import { tagsForConversation } from '$lib/server/tags';
import { renderArtifactCode, renderMarkdown } from '$lib/server/markdown';
import type { Artifact, ConversationState, MessagePart, MessageRow } from '$lib/types/conversation';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { PageServerLoad } from './$types';

async function renderArtifactHtml(a: Artifact): Promise<string> {
	if (a.type === 'code') return await renderArtifactCode(a.content, a.language ?? 'text');
	if (a.type === 'markdown') return await renderMarkdown(a.content);
	if (a.type === 'svg') return a.content;
	// html and mermaid are client-side rendered.
	return '';
}

async function renderPartHtml(part: MessagePart): Promise<MessagePart> {
	if (part.type === 'text' || part.type === 'thinking') {
		if (typeof part.textHtml === 'string' && part.textHtml.length > 0) return part;
		return { ...part, textHtml: await renderMarkdown(part.text) };
	}
	if (part.type === 'tool_use') {
		if (typeof part.inputHtml === 'string' && part.inputHtml.length > 0) return part;
		const code = toolCallCode(part.name, part.input);
		if (code) {
			return { ...part, inputHtml: await renderArtifactCode(code.code, code.language) };
		}
	}
	return part;
}

function toolCallCode(
	name: string,
	input: unknown,
): { code: string; language: string } | null {
	const obj = (input ?? {}) as { code?: unknown; language?: unknown };
	if (typeof obj.code !== 'string' || obj.code.length === 0) return null;
	if (name === 'run_js') return { code: obj.code, language: 'javascript' };
	if (name === 'sandbox_run_code') {
		const lang = typeof obj.language === 'string' ? obj.language : 'python';
		return { code: obj.code, language: lang };
	}
	return null;
}

async function withRenderedMarkdown(state: ConversationState): Promise<ConversationState> {
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
				m.contentHtml && m.contentHtml.length > 0
					? m.contentHtml
					: m.content
						? await renderMarkdown(m.content)
						: null;
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
	const [state, models, initialConversation, defaultModel, styles, conversationTags] =
		await Promise.all([
			stub.getState(),
			listAllModels(platform.env),
			getConversation(platform.env, conversationId),
			getSetting(platform.env, 'default_model'),
			listStyles(platform.env),
			tagsForConversation(platform.env, conversationId),
		]);
	// Optimistic-creation race: the client may navigate to `/c/<id>` before its
	// background `createNewConversation` call lands. If the row is missing but
	// the DO has no messages, materialise the conversation here. We only do
	// this for fresh DOs to avoid resurrecting a conversation that was
	// hard-deleted.
	let conversation = initialConversation;
	if (!conversation && (state as ConversationState).messages.length === 0) {
		await createConversation(platform.env, conversationId);
		conversation = await getConversation(platform.env, conversationId);
	}
	if (!conversation) error(404, 'not found');

	return {
		conversation,
		models,
		styles,
		thinkingBudget: conversation.thinking_budget ?? null,
		styleId: conversation.style_id ?? null,
		systemPromptOverride: conversation.system_prompt ?? '',
		initialState: await withRenderedMarkdown(state),
		defaultModel: defaultModel ?? '',
		conversationTags,
	};
};
