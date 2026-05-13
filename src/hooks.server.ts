import type { Handle } from '@sveltejs/kit';
import { getSetting } from '$lib/server/settings';

const SECURE_HEADERS: Record<string, string> = {
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Origin-Agent-Cluster': '?1',
	'Permissions-Policy': '',
	'Referrer-Policy': 'no-referrer',
	'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
	'X-Content-Type-Options': 'nosniff',
	'X-DNS-Prefetch-Control': 'off',
	'X-Download-Options': 'noopen',
	'X-Frame-Options': 'SAMEORIGIN',
};

function isTheme(v: string | null | undefined): v is App.Locals['theme'] {
	return v === 'system' || v === 'light' || v === 'dark';
}

// In-isolate cache so we don't hit D1 on every request just to look up the
// theme string. Single-user keyspace, refreshed every 30s — that's plenty
// for a "save and see" flow on Settings, and effectively zero in steady
// state.
const THEME_TTL_MS = 30_000;
let themeCache: { value: App.Locals['theme']; fetchedAt: number } | null = null;

async function readTheme(env: Env): Promise<App.Locals['theme']> {
	const now = Date.now();
	if (themeCache && now - themeCache.fetchedAt < THEME_TTL_MS) return themeCache.value;
	const stored = await getSetting(env, 'theme');
	const value = isTheme(stored) ? stored : 'system';
	themeCache = { fetchedAt: now, value };
	return value;
}

// Invalidate the cache when the theme is saved. Imported via the settings
// remote function module after a successful write.
export function invalidateThemeCache(): void {
	themeCache = null;
}

export const handle: Handle = async ({ event, resolve }) => {
	const platform = event.platform;
	event.locals.theme = platform ? await readTheme(platform.env) : 'system';

	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html
				.replace('data-theme="%theme%"', `data-theme="${event.locals.theme}"`)
				.replace('content="%color-scheme%"', `content="${event.locals.theme === 'system' ? 'light dark' : event.locals.theme}"`),
	});

	for (const [k, v] of Object.entries(SECURE_HEADERS)) {
		response.headers.set(k, v);
	}
	return response;
};
