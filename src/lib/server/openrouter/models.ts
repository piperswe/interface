import { OpenRouter } from '@openrouter/sdk';

const FALLBACK_CONTEXT_WINDOW = 128_000;
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedModels: { data: Array<{ id: string; contextLength: number | null; topProvider: { contextLength?: number | null } | null }>; fetchedAt: number } | null = null;

function createClient(env: Env): OpenRouter {
	return new OpenRouter({
		apiKey: env.OPENROUTER_KEY,
		httpReferer: 'https://github.com/piperswe/interface',
		appTitle: 'Interface',
	});
}

function normalizeSlugForLookup(slug: string): string {
	// Bare Anthropic IDs (e.g. "claude-sonnet-4-5") need the vendor prefix
	// for OpenRouter's model list.
	if (slug.startsWith('claude-')) return `anthropic/${slug}`;
	return slug;
}

export async function getModelContextWindow(env: Env, slug: string): Promise<number> {
	const normalized = normalizeSlugForLookup(slug);

	// Warm cache if stale or missing.
	const now = Date.now();
	if (!cachedModels || now - cachedModels.fetchedAt > MODELS_CACHE_TTL_MS) {
		try {
			const client = createClient(env);
			const response = await client.models.list();
			const models = response.data ?? [];
			cachedModels = {
				data: models.map((m) => ({
					id: m.id,
					contextLength: m.contextLength ?? null,
					topProvider: m.topProvider
						? { contextLength: m.topProvider.contextLength ?? null }
						: null,
				})),
				fetchedAt: now,
			};
		} catch {
			/* cache miss is fine — we have a fallback */
		}
	}

	if (cachedModels) {
		const match = cachedModels.data.find((m) => m.id === normalized);
		if (match) {
			const fromModel = match.contextLength;
			const fromProvider = match.topProvider?.contextLength ?? null;
			return fromModel ?? fromProvider ?? FALLBACK_CONTEXT_WINDOW;
		}
	}

	return FALLBACK_CONTEXT_WINDOW;
}

// Exposed for testing.
export function _clearModelsCache(): void {
	cachedModels = null;
}
