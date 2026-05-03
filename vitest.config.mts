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
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations },
				},
			};
		}),
	],
	test: {
		setupFiles: ['./test/setup.ts'],
		coverage: {
			// V8 coverage is not supported by the Workers pool; use istanbul.
			// https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
			provider: 'istanbul',
			include: ['src/**/*.ts', 'src/**/*.tsx'],
			exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/frontend/pages/**/client.tsx'],
		},
	},
});
