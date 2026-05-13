import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import { getConversationStub } from '$lib/server/durable_objects';
import { conversationIdSchema } from '$lib/server/remote-schemas';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

// List currently-exposed preview ports for the conversation sandbox.
export const getSandboxPreviewPorts = command(conversationIdSchema, async (conversationId) => {
	const event = getRequestEvent();
	const hostname = event.url.host;
	const stub = getConversationStub(getEnv(), conversationId);
	const ports = await stub.getSandboxPreviewPorts(hostname);
	return { ports };
});
