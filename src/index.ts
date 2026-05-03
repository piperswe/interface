import { renderIndexPage } from './frontend/pages/index/server';
import { renderConversationPage } from './frontend/pages/conversation/server';
import { renderSettingsPage } from './frontend/pages/settings/server';
import { fetchTopModels, FALLBACK_MODEL } from './openrouter/models';
import { listConversations, createConversation, getConversation } from './conversations';
import { describeProviderKeys, getSetting, setSetting } from './settings';
import { createMcpServer, deleteMcpServer, listMcpServers } from './mcp_servers';

export { default as ConversationDurableObject } from './durable_objects/ConversationDurableObject';

const ALLOWED_SETTING_KEYS = new Set(['theme']);
type Theme = 'system' | 'light' | 'dark';

function isTheme(v: string): v is Theme {
	return v === 'system' || v === 'light' || v === 'dark';
}

async function readTheme(env: Env): Promise<Theme> {
	const v = (await getSetting(env, 'theme')) ?? 'system';
	return isTheme(v) ? v : 'system';
}

const CONVERSATION_PATH = /^\/c\/([0-9a-f-]{36})(?:\/(messages|events|thinking-budget))?$/;

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
			const [conversations, theme] = await Promise.all([listConversations(env), readTheme(env)]);
			return new Response(await renderIndexPage(conversations, { theme }), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		if (url.pathname === '/conversations' && request.method === 'POST') {
			const id = await createConversation(env);
			return redirect(`/c/${id}`);
		}

		if (url.pathname === '/settings') {
			if (request.method === 'GET') {
				const [theme, mcpServers] = await Promise.all([readTheme(env), listMcpServers(env)]);
				return new Response(
					await renderSettingsPage({
						theme,
						providerKeys: describeProviderKeys(env),
						mcpServers,
					}),
					{ headers: { 'Content-Type': 'text/html; charset=utf-8' } },
				);
			}
			if (request.method === 'POST') {
				const form = await request.formData();
				const key = String(form.get('key') ?? '');
				const value = String(form.get('value') ?? '');
				if (!ALLOWED_SETTING_KEYS.has(key)) {
					return new Response(`Unknown setting: ${key}`, { status: 400 });
				}
				if (key === 'theme' && !isTheme(value)) {
					return new Response(`Invalid theme: ${value}`, { status: 400 });
				}
				await setSetting(env, key, value);
				return redirect('/settings');
			}
		}

		if (url.pathname === '/settings/mcp-servers' && request.method === 'POST') {
			const form = await request.formData();
			const name = String(form.get('name') ?? '').trim();
			const transportRaw = String(form.get('transport') ?? '');
			const transport = transportRaw === 'http' || transportRaw === 'sse' ? transportRaw : null;
			const urlField = String(form.get('url') ?? '').trim();
			const authJson = String(form.get('auth_json') ?? '').trim();
			if (!name || !transport || !urlField) {
				return new Response('Missing required fields (name, transport, url)', { status: 400 });
			}
			try {
				new URL(urlField);
			} catch {
				return new Response(`Invalid URL: ${urlField}`, { status: 400 });
			}
			if (authJson) {
				try {
					JSON.parse(authJson);
				} catch {
					return new Response('auth_json must be valid JSON when provided', { status: 400 });
				}
			}
			await createMcpServer(env, {
				name,
				transport,
				url: urlField,
				authJson: authJson || null,
			});
			return redirect('/settings');
		}

		if (url.pathname === '/settings/mcp-servers/delete' && request.method === 'POST') {
			const form = await request.formData();
			const id = Number.parseInt(String(form.get('id') ?? ''), 10);
			if (!Number.isFinite(id) || id <= 0) {
				return new Response('Invalid id', { status: 400 });
			}
			await deleteMcpServer(env, id);
			return redirect('/settings');
		}

		const match = url.pathname.match(CONVERSATION_PATH);
		if (match) {
			const conversationId = match[1];
			const action = match[2];

			if (!action && request.method === 'GET') {
				const stub = env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
				const [state, models, conversation, theme] = await Promise.all([
					stub.getState(),
					fetchTopModels(20),
					getConversation(env, conversationId),
					readTheme(env),
				]);
				if (!conversation) return new Response('Not Found', { status: 404 });
				const modelOptions = models.length > 0 ? models : [FALLBACK_MODEL];
				return new Response(
					await renderConversationPage(
						{
							conversation,
							initialState: state,
							models: modelOptions,
							thinkingBudget: conversation.thinking_budget ?? null,
						},
						{ theme },
					),
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

			if (action === 'thinking-budget' && request.method === 'POST') {
				const form = await request.formData();
				const raw = String(form.get('budget') ?? '0');
				const parsed = Number.parseInt(raw, 10);
				const budget = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
				const stub = env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
				await stub.setThinkingBudget(conversationId, budget);
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
