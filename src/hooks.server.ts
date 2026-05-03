import type { Handle } from '@sveltejs/kit';
import { getSetting } from '$lib/server/settings';

const SECURE_HEADERS: Record<string, string> = {
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'SAMEORIGIN',
	'X-DNS-Prefetch-Control': 'off',
	'X-Download-Options': 'noopen',
	'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Permissions-Policy': '',
	'Origin-Agent-Cluster': '?1',
};

function isTheme(v: string | null | undefined): v is App.Locals['theme'] {
	return v === 'system' || v === 'light' || v === 'dark';
}

export const handle: Handle = async ({ event, resolve }) => {
	const platform = event.platform;
	if (platform) {
		const stored = await getSetting(platform.env, 'theme');
		event.locals.theme = isTheme(stored) ? stored : 'system';
	} else {
		event.locals.theme = 'system';
	}

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
