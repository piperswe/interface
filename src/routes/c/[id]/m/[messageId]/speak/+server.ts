import { error } from '@sveltejs/kit';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import { getConversationStub } from '$lib/server/durable_objects';
import { getTtsVoice } from '$lib/server/settings';
import { extractSpeakableText, synthesizeSpeech } from '$lib/server/tts';
import type { ConversationState } from '$lib/types/conversation';
import type { RequestHandler } from './$types';

// Message ids are short server-generated tokens; keep the pattern strict so
// the URL can't be coerced into anything weird before we hit the DO.
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const GET: RequestHandler = async ({ params, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	const messageId = params.messageId;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');
	if (!MESSAGE_ID_PATTERN.test(messageId)) error(404, 'not found');

	const stub = getConversationStub(platform.env, conversationId);
	const state = (await stub.getState()) as ConversationState;
	const message = state.messages.find((m) => m.id === messageId);
	if (!message) error(404, 'message not found');
	if (message.role !== 'assistant') error(404, 'message not speakable');

	const text = extractSpeakableText(message);
	if (!text) error(422, 'no speakable text in message');

	const voice = await getTtsVoice(platform.env);
	let audio: Response;
	try {
		audio = await synthesizeSpeech(platform.env, text, voice);
	} catch (err) {
		error(502, err instanceof Error ? err.message : String(err));
	}

	return new Response(audio.body, {
		headers: {
			'Content-Type': 'audio/mpeg',
			'Cache-Control': 'private, max-age=3600',
		},
	});
};
