import { renderIndexPage } from './frontend/pages/index/server';
import { renderConversationPage } from './frontend/pages/conversation/server';
import { fetchTopModels, FALLBACK_MODEL } from './openrouter/models';
import { listConversations, createConversation, getConversation } from './conversations';

export { default as ConversationDurableObject } from './durable_objects/ConversationDurableObject';

const CONVERSATION_PATH = /^\/c\/([0-9a-f-]{36})(?:\/(messages|events))?$/;

function redirect(location: string): Response {
	return new Response(null, { status: 303, headers: { Location: location } });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith('/dist/')) {
			url.pathname = url.pathname.replace('/dist/', '/');
			return env.ASSETS.fetch(new Request(url));
		}

		if (url.pathname === '/' || url.pathname === '/index.html') {
			const conversations = await listConversations(env);
			return new Response(await renderIndexPage(conversations), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		if (url.pathname === '/conversations' && request.method === 'POST') {
			const id = await createConversation(env);
			return redirect(`/c/${id}`);
		}

		const match = url.pathname.match(CONVERSATION_PATH);
		if (match) {
			const conversationId = match[1];
			const action = match[2];

			if (!action && request.method === 'GET') {
				const stub = env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
				const [state, models, conversation] = await Promise.all([
					stub.getState(),
					fetchTopModels(20),
					getConversation(env, conversationId),
				]);
				if (!conversation) return new Response('Not Found', { status: 404 });
				const modelOptions = models.length > 0 ? models : [FALLBACK_MODEL];
				return new Response(
					await renderConversationPage({
						conversation,
						state,
						models: modelOptions,
					}),
					{ headers: { 'Content-Type': 'text/html; charset=utf-8' } },
				);
			}

			if (action === 'messages' && request.method === 'POST') {
				const form = await request.formData();
				const content = String(form.get('content') ?? '');
				const model = String(form.get('model') ?? '');
				const stub = env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
				const result = await stub.addUserMessage(conversationId, content, model);
				if (result.status === 'busy') {
					return new Response('Conversation busy: a generation is already in progress', { status: 409 });
				}
				if (result.status === 'invalid') {
					return new Response(`Invalid: ${result.reason}`, { status: 400 });
				}
				return redirect(`/c/${conversationId}`);
			}

			if (action === 'events' && request.method === 'GET') {
				const stub = env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
				const stream = await stub.subscribe();
				return new Response(stream, {
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
					},
				});
			}
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
