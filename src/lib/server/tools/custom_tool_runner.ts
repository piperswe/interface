import type { CustomToolRow } from '../custom_tools';
import { parseInputSchema, parseSecretsJson } from '../custom_tools';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

const HOST_COMPAT_DATE = '2026-04-22';
const DEFAULT_CPU_MS = 10_000;
const DEFAULT_SUBREQUESTS = 50;

// Stable cache key for the loader so repeat calls reuse the isolate. Edits
// to source OR secrets change the hash, evicting the cached worker —
// otherwise an agent that updates a tool would keep running the old code (or
// reading the old env) on its next invocation.
//
// We use the full 64-hex SHA-256 rather than truncating to 16 hex chars
// (64 bits) — the birthday bound on 64 bits is ~2^32 entries, well below
// the cap on what an agent could plausibly write. There is no length budget
// on the cache key.
async function buildCacheKey(row: CustomToolRow): Promise<string> {
	const data = new TextEncoder().encode(`${row.source}\0${row.secretsJson ?? ''}`);
	const hashBuf = await crypto.subtle.digest('SHA-256', data);
	const hashHex = Array.from(new Uint8Array(hashBuf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `custom-${row.id}-${hashHex}`;
}

export function customToolNamespacedName(row: CustomToolRow): string {
	return `custom_${row.id}_${row.name}`;
}

export function buildCustomTool(row: CustomToolRow): Tool {
	return {
		definition: {
			description: row.description,
			inputSchema: parseInputSchema(row.inputSchema),
			name: customToolNamespacedName(row),
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const loader = ctx.env.RUN_JS_LOADER;
			if (!loader) {
				return {
					content: 'RUN_JS_LOADER binding is not configured.',
					errorCode: 'execution_failure',
					isError: true,
				};
			}
			const env = parseSecretsJson(row.secretsJson);
			try {
				const cacheKey = await buildCacheKey(row);
				const stub = loader.get(cacheKey, () => ({
					compatibilityDate: HOST_COMPAT_DATE,
					compatibilityFlags: ['nodejs_compat'],
					env,
					limits: { cpuMs: DEFAULT_CPU_MS, subRequests: DEFAULT_SUBREQUESTS },
					mainModule: 'tool.js',
					modules: { 'tool.js': { js: row.source } },
				}));
				const entrypoint = stub.getEntrypoint() as unknown as { run(input: unknown): Promise<unknown> };
				const result = await entrypoint.run(input);
				return formatResult(result);
			} catch (e) {
				return {
					content: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
					errorCode: 'execution_failure',
					isError: true,
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
		// `replacer` handles BigInt (JSON.stringify throws on it by default) and
		// any other non-serialisable value: stringify it so the agent gets a
		// reasonable representation rather than `[object Object]`.
		const replacer = (_key: string, value: unknown) => {
			if (typeof value === 'bigint') return value.toString();
			if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
			if (typeof value === 'symbol') return value.toString();
			if (typeof value === 'undefined') return null;
			return value;
		};
		return { content: JSON.stringify(result, replacer, 2) };
	} catch (e) {
		return {
			content: `(unable to serialise return value: ${e instanceof Error ? e.message : String(e)})`,
			errorCode: 'execution_failure',
			isError: true,
		};
	}
}
