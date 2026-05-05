import { command, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { getConversationStub } from '$lib/server/durable_objects';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

function stubFor(id: string) {
	if (!CONVERSATION_ID_PATTERN.test(id)) error(400, `invalid conversation id: ${id}`);
	return getConversationStub(getEnv(), id);
}

// List files and directories inside the conversation sandbox.
export const listSandboxFiles = command('unchecked', async (input: { conversationId: string; path?: string }) => {
	const stub = stubFor(input.conversationId);
	const files = await stub.listSandboxFiles(input.path ?? '/workspace');
	return { files };
});

// List currently-exposed preview ports for the conversation sandbox.
export const getSandboxPreviewPorts = command('unchecked', async (conversationId: string) => {
	const stub = stubFor(conversationId);
	const ports = await stub.getSandboxPreviewPorts();
	return { ports };
});
