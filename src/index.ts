import { renderIndexPage } from './frontend/pages/index/server';

export { default as ChatDurableObject } from './durable_objects/ChatDurableObject';

type OpenRouterFrontendModel = {
	slug: string;
	short_name?: string;
	name?: string;
	is_hidden?: boolean;
	is_disabled?: boolean;
};

const FALLBACK_MODEL = { slug: 'openai/gpt-5.5', label: 'GPT-5.5' };

function escapeHtml(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function fetchTopModels(limit: number): Promise<Array<{ slug: string; label: string }>> {
	try {
		const response = await fetch('https://openrouter.ai/api/frontend/models/find?order=top-weekly', {
			headers: { Accept: 'application/json' },
		});
		if (!response.ok) throw new Error(`Status ${response.status}`);
		const body = (await response.json()) as { data?: { models?: OpenRouterFrontendModel[] } };
		const models = body.data?.models ?? [];
		return models
			.filter((m) => m && m.slug && !m.is_hidden && !m.is_disabled)
			.slice(0, limit)
			.map((m) => ({ slug: m.slug, label: m.short_name || m.name || m.slug }));
	} catch {
		return [FALLBACK_MODEL];
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith('/dist/')) {
			url.pathname = url.pathname.replace('/dist/', '/');
			return env.ASSETS.fetch(new Request(url));
		}

		if (url.pathname === '/api/hello') {
			const question = url.searchParams.get('q');
			if (!question) {
				return new Response('Missing q parameter', { status: 400 });
			}
			const model = url.searchParams.get('model') ?? undefined;
			const stub = env.CHAT_DURABLE_OBJECT.getByName('foo');
			const stream = await stub.ask(question, model);
			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
				},
			});
		}

		if (url.pathname === '/' || url.pathname === '/index.html') {
			const models = await fetchTopModels(20);
			return new Response(await renderIndexPage(models.map((m) => m.slug)), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
