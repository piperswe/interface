import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	resolve: {
		alias: {
			// The `ynab` SDK's runtime calls `require("fetch-ponyfill")()` at
			// module load. The CJS entry of fetch-ponyfill pulls in node-fetch
			// and its Node-only deps, which bloats the Worker bundle. Workers
			// already have native fetch, so we redirect the import to a shim.
			'fetch-ponyfill': path.resolve(__dirname, 'src/lib/server/ynab/fetch-ponyfill-shim.cjs'),
		},
	},
});
