import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

const HOST_COMPAT_DATE = '2026-04-22';

const inputArgsSchema = z.object({
	code: z.string(),
	timeout: z.number().optional(),
});
const DEFAULT_CPU_MS = 5000;
const MAX_CPU_MS = 30_000;
const DEFAULT_SUBREQUESTS = 50;

const inputSchema = {
	type: 'object',
	properties: {
		code: {
			type: 'string',
			description:
				'JavaScript executed as the body of an async function — use `await` and `return` freely. `console.log` / `warn` / `error` are captured. The return value is JSON-serialized when possible.',
		},
		timeout: {
			type: 'integer',
			minimum: 100,
			maximum: MAX_CPU_MS,
			description: `CPU time limit in milliseconds (default ${DEFAULT_CPU_MS}, max ${MAX_CPU_MS}).`,
		},
	},
	required: ['code'],
} as const;

// Host module that loads a separate `user.js` module from the loader's
// `modules` map. Keeping the user code in its own module entry means there's
// no lexical embedding (i.e. no `${userCode}` interpolation) — the agent
// can't terminate a wrapping function and redefine `export default`.
const HOST_MODULE = `import { WorkerEntrypoint } from 'cloudflare:workers';
import * as userMod from './user.js';

function fmt(v) {
	if (typeof v === 'string') return v;
	try { return JSON.stringify(v); } catch { return String(v); }
}
function makeConsole(logs) {
	const push = (level) => (...a) => logs.push({ level, msg: a.map(fmt).join(' ') });
	return { log: push('log'), warn: push('warn'), error: push('error'), info: push('log'), debug: push('log') };
}

export default class extends WorkerEntrypoint {
	async run() {
		const logs = [];
		const userConsole = makeConsole(logs);
		try {
			const entry = typeof userMod.default === 'function'
				? userMod.default
				: (typeof userMod.run === 'function' ? userMod.run : null);
			if (!entry) {
				return { ok: false, error: 'run_js: module must export a default function or a "run" function', logs };
			}
			const result = await entry({ console: userConsole });
			if (result === undefined) return { ok: true, logs };
			let serialized;
			try { serialized = JSON.parse(JSON.stringify(result)); }
			catch { serialized = String(result); }
			return { ok: true, result: serialized, logs };
		} catch (e) {
			const error = e instanceof Error
				? e.name + ': ' + e.message + (e.stack ? '\\n' + e.stack : '')
				: String(e);
			return { ok: false, error, logs };
		}
	}
}
`;

// Wrap user code in an async default-export function. The body sees a
// `console` captured by the host. Since user.js is its own module entry in
// the loader's modules map, the host module never lexically embeds the user
// string — eliminating the template-injection vector.
function buildUserModule(userCode: string): string {
	return `export default async function ({ console }) {\n${userCode}\n}\n`;
}

type RunLog = { level: string; msg: string };
type RunResult =
	| { ok: true; result: unknown; logs: RunLog[] }
	| { ok: false; error: string; logs: RunLog[] };

export const runJsTool: Tool = {
	definition: {
		name: 'run_js',
		description:
			"Run JavaScript in a fresh, isolated Cloudflare Worker (v8 isolate). The code is executed as the body of an async function — use `await` and `return` freely; the returned value is reported back JSON-serialized when possible, and `console.log` / `warn` / `error` are captured. The isolate has network access (`fetch`) but no project bindings or secrets, and no state is preserved across calls. Prefer this over `sandbox_run_code` for most computation, parsing, transforms, or hitting public HTTP APIs — it spins up much faster. Only use `sandbox_run_code` if you need a filesystem.",
		inputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(inputArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		const loader = ctx.env.RUN_JS_LOADER;
		if (!loader) {
			return {
				content: 'RUN_JS_LOADER binding is not configured.',
				isError: true,
				errorCode: 'execution_failure',
			};
		}
		const cpuMs = clampTimeout(args.timeout);
		try {
			const stub = loader.load({
				compatibilityDate: HOST_COMPAT_DATE,
				compatibilityFlags: ['nodejs_compat'],
				mainModule: 'main.js',
				modules: {
					'main.js': { js: HOST_MODULE },
					'user.js': { js: buildUserModule(args.code) },
				},
				env: {},
				limits: { cpuMs, subRequests: DEFAULT_SUBREQUESTS },
			});
			const entrypoint = stub.getEntrypoint() as unknown as { run(): Promise<RunResult> };
			const result = await entrypoint.run();
			return formatRunResult(result);
		} catch (e) {
			return {
				content: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
				isError: true,
				errorCode: 'execution_failure',
			};
		}
	},
};

function clampTimeout(timeout: number | undefined): number {
	if (typeof timeout !== 'number' || !Number.isFinite(timeout)) return DEFAULT_CPU_MS;
	if (timeout < 100) return 100;
	if (timeout > MAX_CPU_MS) return MAX_CPU_MS;
	return Math.floor(timeout);
}

function formatRunResult(result: RunResult): ToolExecutionResult {
	const lines: string[] = [];
	if (result.logs.length > 0) {
		lines.push('--- console ---');
		for (const log of result.logs) {
			lines.push(log.level === 'log' ? log.msg : `[${log.level}] ${log.msg}`);
		}
	}
	if (result.ok) {
		if (result.result !== undefined) {
			if (lines.length > 0) lines.push('');
			lines.push('--- result ---');
			lines.push(
				typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2),
			);
		} else if (lines.length === 0) {
			lines.push('(no output)');
		}
		return { content: lines.join('\n') };
	}
	if (lines.length > 0) lines.push('');
	lines.push('--- error ---');
	lines.push(result.error);
	return { content: lines.join('\n'), isError: true, errorCode: 'execution_failure' };
}
