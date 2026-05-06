import { error } from '@sveltejs/kit';
import { createConversation, getConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { listAllModels } from '$lib/server/providers/models';
import { getKagiCostPer1000Searches, getSetting } from '$lib/server/settings';
import { listStyles } from '$lib/server/styles';
import { tagsForConversation } from '$lib/server/tags';
import type { ConversationState } from '$lib/types/conversation';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const stub = getConversationStub(platform.env, conversationId);
	const [
		state,
		models,
		initialConversation,
		defaultModel,
		styles,
		conversationTags,
		kagiCostPer1000Searches,
	] = await Promise.all([
		stub.getState(),
		listAllModels(platform.env),
		getConversation(platform.env, conversationId),
		getSetting(platform.env, 'default_model'),
		listStyles(platform.env),
		tagsForConversation(platform.env, conversationId),
		getKagiCostPer1000Searches(platform.env),
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
		initialState: state as ConversationState,
		defaultModel: defaultModel ?? '',
		conversationTags,
		kagiCostPer1000Searches,
	};
};
