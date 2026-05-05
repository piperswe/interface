import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// `@cloudflare/containers` ships broken ESM (missing "type": "module" in
// package.json so bare specifiers like `./lib/container` aren't resolved).
// This plugin rewrites those bare sub-path imports to the actual `.js` files.
const fixContainersPlugin = () => ({
	name: 'fix-cloudflare-containers',
	enforce: 'pre',
	resolveId(id, importer) {
		if (id.startsWith('@cloudflare/containers/')) {
			// Resolve sub-imports to the actual JS file
			const subPath = id.replace('@cloudflare/containers/', '');
			return path.resolve(
				__dirname,
				'node_modules/@cloudflare/containers/dist',
				subPath + '.js',
			);
		}
		if (importer?.includes('@cloudflare/containers') && id.startsWith('.')) {
			// Resolve relative imports inside the package
			const importerDir = path.dirname(importer);
			return path.resolve(importerDir, id + '.js');
		}
		return null;
	},
});

export default defineConfig({
	plugins: [fixContainersPlugin(), sveltekit()],
	build: {
		sourcemap: true,
	},
	resolve: {
		alias: {
			// The `ynab` SDK's runtime calls `require("fetch-ponyfill")()` at
			// module load. The CJS entry of fetch-ponyfill pulls in node-fetch
			// and its Node-only deps, which bloats the Worker bundle. Workers
			// already have native fetch, so we redirect the import to a shim.
			'fetch-ponyfill': path.resolve(__dirname, 'src/lib/server/ynab/fetch-ponyfill-shim.cjs'),
			// Worker-runtime imports can't be loaded by Node.js during the SSR
			// build; alias them to stubs so the bundle step succeeds.
			'cloudflare:workers': path.resolve(__dirname, 'src/lib/server/stubs/cloudflare-workers.ts'),
			'cloudflare:test': path.resolve(__dirname, 'src/lib/server/stubs/cloudflare-test.ts'),
		},
	},
	ssr: {
		// Worker runtime modules can't be loaded by Node.js during the SSR
		// build; keep them external so the adapter bundles them correctly.
		external: ['cloudflare:workers', 'cloudflare:sockets', 'cloudflare:test'],
	},
});
