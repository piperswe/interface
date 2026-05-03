import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			$lib: path.resolve(__dirname, 'src/lib'),
			'$app/server': path.resolve(__dirname, 'test/shims/app-server.ts'),
		},
	},
	// @openrouter/sdk ships sourceMappingURL comments without the `.map` files;
	// silence vite's noisy "Failed to load source map" warnings.
	logLevel: 'error',
	plugins: [
		cloudflareTest(async () => {
			const migrationsPath = path.join(__dirname, 'migrations');
			const migrations = await readD1Migrations(migrationsPath);
			return {
				wrangler: { configPath: './wrangler.test.jsonc' },
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations },
				},
			};
		}),
	],
	test: {
		setupFiles: ['./test/setup.ts'],
		// Tests target server-side modules under `src/lib/server/`. Component
		// behaviour is exercised through the integration tests that drive the
		// Durable Object end-to-end; we don't run a Svelte SSR test runner here.
		include: ['src/lib/**/*.test.ts', 'test/**/*.test.ts'],
		coverage: {
			// V8 coverage is not supported by the Workers pool; use istanbul.
			// https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
			provider: 'istanbul',
			include: ['src/lib/**/*.ts'],
			exclude: ['src/lib/**/*.test.ts', 'src/**/*.svelte'],
		},
	},
});
