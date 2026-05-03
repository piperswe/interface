type OpenRouterFrontendModel = {
	slug: string;
	short_name?: string;
	name?: string;
	is_hidden?: boolean;
	is_disabled?: boolean;
};

export type ModelEntry = { slug: string; label: string };

export const FALLBACK_MODEL: ModelEntry = { slug: '~openai/gpt-latest', label: 'GPT (latest)' };

const MODELS_URL = 'https://openrouter.ai/api/frontend/models/find?order=top-weekly';
const CACHE_TTL_SECONDS = 600;

// DOM's lib.dom.d.ts declares a `CacheStorage` without `.default`, which shadows the
// Workers runtime's augmented type. Cast to the Workers shape for direct cache access.
const workerCaches = caches as unknown as { default: Cache };

async function fetchModelsResponse(): Promise<Response> {
	const cache = workerCaches.default;
	const cacheKey = new Request(MODELS_URL, { method: 'GET' });
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const fresh = await fetch(MODELS_URL, { headers: { Accept: 'application/json' } });
	if (!fresh.ok) return fresh;

	const cacheable = new Response(fresh.body, fresh);
	cacheable.headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
	if (cacheable.body) {
		const [forCache, forReturn] = cacheable.body.tee();
		await cache.put(cacheKey, new Response(forCache, cacheable));
		return new Response(forReturn, cacheable);
	}
	return cacheable;
}

export async function fetchTopModels(limit: number): Promise<ModelEntry[]> {
	try {
		const response = await fetchModelsResponse();
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
