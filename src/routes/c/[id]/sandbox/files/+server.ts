import { error, json } from '@sveltejs/kit';
import { getConversationStub } from '$lib/server/durable_objects';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const path = url.searchParams.get('path') ?? '/workspace';
	if (!path.startsWith('/workspace') && !path.startsWith('/tmp')) {
		error(400, 'invalid path');
	}

	const stub = getConversationStub(platform.env, conversationId);
	const files = await stub.listSandboxFiles(path);
	return json(files);
};
