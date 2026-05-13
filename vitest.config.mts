import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// @openrouter/sdk ships sourceMappingURL comments without the `.map` files;
	// silence vite's noisy "Failed to load source map" warnings.
	logLevel: 'error',
	plugins: [
		cloudflareTest(async () => {
			const migrationsPath = path.join(__dirname, 'migrations');
			const migrations = await readD1Migrations(migrationsPath);
			return {
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations },
					// Per-runner D1: miniflare keys D1 storage by database id, so a
					// fixed id in wrangler.test.jsonc would force every parallel
					// runner to share one SQLite file and race on `DELETE FROM`
					// cleanups. A unique id per runner gives each test file its
					// own database; `test/setup.ts` migrates it in beforeAll.
					d1Databases: { DB: crypto.randomUUID() },
				},
				wrangler: { configPath: './wrangler.test.jsonc' },
			};
		}),
	],
	resolve: {
		alias: {
			'$app/server': path.resolve(__dirname, 'test/shims/app-server.ts'),
			$lib: path.resolve(__dirname, 'src/lib'),
			// See vite.config.ts — sidestep fetch-ponyfill's node-fetch chain.
			'fetch-ponyfill': path.resolve(__dirname, 'src/lib/server/ynab/fetch-ponyfill-shim.cjs'),
		},
	},
	test: {
		coverage: {
			exclude: ['src/lib/**/*.test.ts', 'src/**/*.svelte'],
			include: ['src/lib/**/*.ts'],
			// V8 coverage is not supported by the Workers pool; use istanbul.
			// https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
			provider: 'istanbul',
		},
		fileParallelism: true,
		// Tests target server-side modules under `src/lib/server/`. Component
		// behaviour is exercised through the integration tests that drive the
		// Durable Object end-to-end; we don't run a Svelte SSR test runner here.
		include: ['src/lib/**/*.test.ts', 'src/routes/**/*.test.ts', 'test/**/*.test.ts'],
		maxWorkers: '125%',
		minWorkers: 1,
		setupFiles: ['./test/setup.ts'],
	},
});
