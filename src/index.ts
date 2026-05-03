import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { etag } from 'hono/etag';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { renderIndexPage } from './frontend/pages/index/server';
import { renderConversationPage } from './frontend/pages/conversation/server';
import { renderSettingsPage } from './frontend/pages/settings/server';
import { listConversations, createConversation, getConversation } from './conversations';
import {
	describeProviderKeys,
	getSetting,
	setSetting,
	getContextCompactionThreshold,
	getContextCompactionSummaryTokens,
	getModelList,
	getSystemPrompt,
	getUserBio,
} from './settings';
import { serializeModelList } from './models/config';
import { createMcpServer, deleteMcpServer, listMcpServers } from './mcp_servers';

export { default as ConversationDurableObject } from './durable_objects/ConversationDurableObject';

const ALLOWED_SETTING_KEYS = new Set(['theme', 'context_compaction_threshold', 'context_compaction_summary_tokens', 'model_list', 'system_prompt', 'user_bio']);
type Theme = 'system' | 'light' | 'dark';
const CONVERSATION_ID_PATTERN = /^[0-9a-f-]{36}$/;

function isTheme(v: string): v is Theme {
	return v === 'system' || v === 'light' || v === 'dark';
}

async function readTheme(env: Env): Promise<Theme> {
	const v = (await getSetting(env, 'theme')) ?? 'system';
	return isTheme(v) ? v : 'system';
}

function isValidThreshold(v: string): boolean {
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n >= 0 && n <= 100;
}

function isValidSummaryTokens(v: string): boolean {
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n >= 256;
}

function htmlStream(stream: ReadableStream<Uint8Array>): Response {
	return new Response(stream, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}

const app = new Hono<{ Bindings: Env }>();

// --- Middleware ----------------------------------------------------------------------------

app.use('*', logger());

// secureHeaders adds X-Frame-Options, Referrer-Policy, etc. by default and
// only sets CSP when explicitly configured. Skipping CSP for now because
// React 19's `bootstrapScriptContent` ships an inline `<script>` carrying
// `window.__PROPS__` on the conversation page; tightening to nonce-based CSP
// is a follow-up once we have a single inline-script seam to instrument.
app.use('*', secureHeaders());

// CSRF: only allow same-origin POSTs (Origin header host must match request host).
app.use(
	'*',
	csrf({
		origin: (origin, c) => {
			try {
				return new URL(origin).host === new URL(c.req.url).host;
			} catch {
				return false;
			}
		},
	}),
);

app.use('/dist/*', etag());

// --- Routes --------------------------------------------------------------------------------

// Static assets — proxied to the wrangler-managed ASSETS binding. Cloning the
// response so the etag middleware can append its header (ASSETS hands back an
// immutable Response).
app.get('/dist/*', async (c) => {
	const url = new URL(c.req.url);
	url.pathname = url.pathname.replace('/dist/', '/');
	const upstream = await c.env.ASSETS.fetch(new Request(url));
	return new Response(upstream.body, upstream);
});

// Index
app.get('/', async (c) => {
	const [conversations, theme] = await Promise.all([listConversations(c.env), readTheme(c.env)]);
	return htmlStream(await renderIndexPage(conversations, { theme }));
});
app.get('/index.html', (c) => c.redirect('/', 301));

// Create conversation
app.post('/conversations', async (c) => {
	const id = await createConversation(c.env);
	return c.redirect(`/c/${id}`, 303);
});

// Settings
app.get('/settings', async (c) => {
	const [theme, mcpServers, conversations, threshold, summaryTokens, modelList, systemPrompt, userBio] = await Promise.all([
		readTheme(c.env),
		listMcpServers(c.env),
		listConversations(c.env),
		getContextCompactionThreshold(c.env),
		getContextCompactionSummaryTokens(c.env),
		getModelList(c.env),
		getSystemPrompt(c.env),
		getUserBio(c.env),
	]);
	return htmlStream(
		await renderSettingsPage(
			{
				theme,
				providerKeys: describeProviderKeys(c.env),
				mcpServers,
				contextCompactionThreshold: threshold,
				contextCompactionSummaryTokens: summaryTokens,
				modelListRaw: serializeModelList(modelList),
				systemPrompt: systemPrompt ?? '',
				userBio: userBio ?? '',
			},
			{ conversations },
		),
	);
});

app.post('/settings', async (c) => {
	const form = await c.req.formData();
	const key = String(form.get('key') ?? '');
	let value = String(form.get('value') ?? '');
	if (!ALLOWED_SETTING_KEYS.has(key)) {
		return c.text(`Unknown setting: ${key}`, 400);
	}
	if (key === 'theme' && !isTheme(value)) {
		return c.text(`Invalid theme: ${value}`, 400);
	}
	if (key === 'context_compaction_threshold' && !isValidThreshold(value)) {
		return c.text('Threshold must be an integer between 0 and 100', 400);
	}
	if (key === 'context_compaction_summary_tokens' && !isValidSummaryTokens(value)) {
		return c.text('Summary budget must be at least 256 tokens', 400);
	}
	await setSetting(c.env, key, value);
	return c.redirect('/settings', 303);
});

app.post('/settings/mcp-servers', async (c) => {
	const form = await c.req.formData();
	const name = String(form.get('name') ?? '').trim();
	const transportRaw = String(form.get('transport') ?? '');
	const transport: 'http' | 'sse' | null =
		transportRaw === 'http' || transportRaw === 'sse' ? transportRaw : null;
	const urlField = String(form.get('url') ?? '').trim();
	const authJson = String(form.get('auth_json') ?? '').trim();
	if (!name || !transport || !urlField) {
		return c.text('Missing required fields (name, transport, url)', 400);
	}
	try {
		new URL(urlField);
	} catch {
		return c.text(`Invalid URL: ${urlField}`, 400);
	}
	if (authJson) {
		try {
			JSON.parse(authJson);
		} catch {
			return c.text('auth_json must be valid JSON when provided', 400);
		}
	}
	await createMcpServer(c.env, {
		name,
		transport,
		url: urlField,
		authJson: authJson || null,
	});
	return c.redirect('/settings', 303);
});

app.post('/settings/mcp-servers/delete', async (c) => {
	const form = await c.req.formData();
	const id = Number.parseInt(String(form.get('id') ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) {
		return c.text('Invalid id', 400);
	}
	await deleteMcpServer(c.env, id);
	return c.redirect('/settings', 303);
});

// Conversation page
app.get('/c/:id', async (c) => {
	const conversationId = c.req.param('id');
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) return c.notFound();
	const stub = c.env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
	const [state, models, conversation, theme, conversations] = await Promise.all([
		stub.getState(),
		getModelList(c.env),
		getConversation(c.env, conversationId),
		readTheme(c.env),
		listConversations(c.env),
	]);
	if (!conversation) return c.notFound();
	return htmlStream(
		await renderConversationPage(
			{
				conversation,
				initialState: state,
				models,
				thinkingBudget: conversation.thinking_budget ?? null,
			},
			{ theme, conversations },
		),
	);
});

app.post('/c/:id/messages', async (c) => {
	const conversationId = c.req.param('id');
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) return c.notFound();
	const form = await c.req.formData();
	const content = String(form.get('content') ?? '');
	const model = String(form.get('model') ?? '');
	const stub = c.env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
	const result = await stub.addUserMessage(conversationId, content, model);
	if (result.status === 'busy') {
		return c.text('Conversation busy: a generation is already in progress', 409);
	}
	if (result.status === 'invalid') {
		return c.text(`Invalid: ${result.reason}`, 400);
	}
	return c.redirect(`/c/${conversationId}`, 303);
});

app.post('/c/:id/regenerate-title', async (c) => {
	const conversationId = c.req.param('id');
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) return c.notFound();
	const stub = c.env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
	await stub.regenerateTitle(conversationId);
	return c.redirect(`/c/${conversationId}`, 303);
});

app.post('/c/:id/thinking-budget', async (c) => {
	const conversationId = c.req.param('id');
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) return c.notFound();
	const form = await c.req.formData();
	const raw = String(form.get('budget') ?? '0');
	const parsed = Number.parseInt(raw, 10);
	const budget = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	const stub = c.env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
	await stub.setThinkingBudget(conversationId, budget);
	return c.redirect(`/c/${conversationId}`, 303);
});

app.get('/c/:id/events', async (c) => {
	const conversationId = c.req.param('id');
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) return c.notFound();
	const stub = c.env.CONVERSATION_DURABLE_OBJECT.getByName(conversationId);
	const stream = await stub.subscribe();
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
});

export default app;
