import { command, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { getConversationStub } from '$lib/server/durable_objects';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import { getEnv } from '$lib/server/remote-helpers';

function stubFor(id: string) {
	if (!CONVERSATION_ID_PATTERN.test(id)) error(400, `invalid conversation id: ${id}`);
	return getConversationStub(getEnv(), id);
}

// List currently-exposed preview ports for the conversation sandbox.
export const getSandboxPreviewPorts = command('unchecked', async (conversationId: string) => {
	const event = getRequestEvent();
	const hostname = event.url.host;
	const stub = stubFor(conversationId);
	const ports = await stub.getSandboxPreviewPorts(hostname);
	return { ports };
});
