import { error } from '@sveltejs/kit';
import { getConversationStub } from '$lib/server/durable_objects';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { RequestHandler } from './$types';

// SSE endpoint for live conversation events. Remote functions can't return
// streaming responses, so we keep this as a `+server.ts` route — that's the
// SvelteKit-idiomatic way to stream. The Durable Object's `subscribe()`
// method returns the ReadableStream we proxy back.
export const GET: RequestHandler = async ({ params, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const id = params.id;
	if (!CONVERSATION_ID_PATTERN.test(id)) error(404, 'not found');

	const stub = getConversationStub(platform.env, id);
	const stream = await stub.subscribe();
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
};
