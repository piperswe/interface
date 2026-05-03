import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			platformProxy: {
				configPath: 'wrangler.jsonc',
				persist: true,
			},
		}),
		experimental: {
			remoteFunctions: true,
		},
		csrf: {
			trustedOrigins: [],
		},
	},
	compilerOptions: {
		experimental: {
			async: true,
		},
	},
};

export default config;
