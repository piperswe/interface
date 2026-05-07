import type { Tool, ToolContext, ToolExecutionResult } from './registry';
import type { CustomToolRow } from '../custom_tools';
import { parseInputSchema, parseSecretsJson } from '../custom_tools';

const HOST_COMPAT_DATE = '2026-04-22';
const DEFAULT_CPU_MS = 10_000;
const DEFAULT_SUBREQUESTS = 50;

// Stable cache key for the loader so repeat calls reuse the isolate. Edits
// to source OR secrets change the hash, evicting the cached worker —
// otherwise an agent that updates a tool would keep running the old code (or
// reading the old env) on its next invocation.
async function buildCacheKey(row: CustomToolRow): Promise<string> {
	const data = new TextEncoder().encode(row.source + '\0' + (row.secretsJson ?? ''));
	const hashBuf = await crypto.subtle.digest('SHA-256', data);
	const hashHex = Array.from(new Uint8Array(hashBuf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `custom-${row.id}-${hashHex.slice(0, 16)}`;
}

export function customToolNamespacedName(row: CustomToolRow): string {
	return `custom_${row.id}_${row.name}`;
}

export function buildCustomTool(row: CustomToolRow): Tool {
	return {
		definition: {
			name: customToolNamespacedName(row),
			description: row.description,
			inputSchema: parseInputSchema(row.inputSchema),
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const loader = ctx.env.RUN_JS_LOADER;
			if (!loader) {
				return {
					content: 'RUN_JS_LOADER binding is not configured.',
					isError: true,
					errorCode: 'execution_failure',
				};
			}
			const env = parseSecretsJson(row.secretsJson);
			try {
				const cacheKey = await buildCacheKey(row);
				const stub = loader.get(cacheKey, () => ({
					compatibilityDate: HOST_COMPAT_DATE,
					compatibilityFlags: ['nodejs_compat'],
					mainModule: 'tool.js',
					modules: { 'tool.js': { js: row.source } },
					env,
					limits: { cpuMs: DEFAULT_CPU_MS, subRequests: DEFAULT_SUBREQUESTS },
				}));
				const entrypoint = stub.getEntrypoint() as unknown as { run(input: unknown): Promise<unknown> };
				const result = await entrypoint.run(input);
				return formatResult(result);
			} catch (e) {
				return {
					content: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
					isError: true,
					errorCode: 'execution_failure',
				};
			}
		},
	};
}

function formatResult(result: unknown): ToolExecutionResult {
	if (result === undefined || result === null) {
		return { content: '(no result)' };
	}
	if (typeof result === 'string') {
		return { content: result };
	}
	try {
		return { content: JSON.stringify(result, null, 2) };
	} catch {
		return { content: String(result) };
	}
}
