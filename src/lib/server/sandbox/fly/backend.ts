// fly.io Machines backend. See `./machines-api.ts` for the REST client,
// `./lifecycle.ts` for the per-conversation machine bookkeeping, and
// `./file-ops.ts` for the shell-mediated file I/O.

import {
	execMachine,
	flyConfigFromEnv,
	type FlyConfig,
} from './machines-api';
import { destroyManagedMachine, ensureMachine, getCachedMachineId } from './lifecycle';
import {
	deleteFileShell,
	existsShell,
	mkdirShell,
	readFileShell,
	runCodeShell,
	writeFileShell,
} from './file-ops';
import { clearExposedPorts, listExposedPorts, recordExposedPort } from './d1';
import type {
	ExecEvent,
	ExecOptions,
	ExecResult,
	ExecStream,
	ExposedPort,
	ReadFileResult,
	RunCodeLanguage,
	RunCodeResult,
	SandboxBackend,
	SandboxInstance,
} from '../backend';

// POSIX env var name. Anything outside [A-Za-z_][A-Za-z0-9_]* would
// otherwise be interpolated raw into a shell `export` and run as code
// (e.g. an LLM-supplied key like `FOO;rm -rf /`). Cloudflare's path
// passes env vars to the SDK and never goes near a shell, so this is
// fly-specific defense; rejecting invalid keys matches POSIX semantics
// anyway since `export FOO;...=v` isn't a valid env binding.
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Exported for unit testing. Internal call sites use this via `execOnce`.
export function _buildShellCommand(cmd: string, opts: ExecOptions): string {
	return buildShellCommand(cmd, opts);
}

function buildShellCommand(cmd: string, opts: ExecOptions): string {
	// We always shell out via bash so the agent-supplied command string
	// behaves the way it would in a terminal (pipes, redirects, &&, ||).
	const parts: string[] = [];
	if (opts.env) {
		for (const [k, v] of Object.entries(opts.env)) {
			if (!POSIX_ENV_NAME.test(k)) {
				throw new Error(`Invalid env var name (must match ${POSIX_ENV_NAME}): ${k}`);
			}
			parts.push(`export ${k}=${JSON.stringify(v)}`);
		}
	}
	if (opts.cwd) {
		parts.push(`cd ${JSON.stringify(opts.cwd)}`);
	}
	parts.push(cmd);
	return parts.join('\n');
}

async function execOnce(
	cfg: FlyConfig,
	machineId: string,
	cmd: string,
	opts: ExecOptions,
): Promise<ExecResult> {
	const script = buildShellCommand(cmd, opts);
	const resp = await execMachine(cfg, machineId, {
		cmd: ['bash', '-lc', script],
		...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
		...(opts.timeout ? { timeout: Math.ceil(opts.timeout / 1000) } : {}),
	});
	return {
		exitCode: resp.exit_code,
		success: resp.exit_code === 0,
		stdout: resp.stdout ?? '',
		stderr: resp.stderr ?? '',
	};
}

// `execStream` shape — for fly we run the command synchronously and emit
// the complete result as a single trailing burst. True chunk-by-chunk
// streaming requires the WebSocket exec endpoint, which uses an
// undocumented framing protocol; switching to it is a one-file change
// here. (See plan Risk #1.)
function streamFromResult(result: ExecResult): ExecStream {
	let cancelled = false;
	const iter: AsyncIterable<ExecEvent> = {
		async *[Symbol.asyncIterator]() {
			if (cancelled) {
				yield { type: 'error', error: 'cancelled' };
				return;
			}
			if (result.stdout) yield { type: 'stdout', data: result.stdout };
			if (result.stderr) yield { type: 'stderr', data: result.stderr };
			yield { type: 'complete', exitCode: result.exitCode };
		},
	};
	return Object.assign(iter, {
		async cancel() {
			cancelled = true;
		},
	});
}

class FlySandboxInstance implements SandboxInstance {
	#env: Env;
	#cfg: FlyConfig;
	#conversationId: string;

	constructor(env: Env, cfg: FlyConfig, conversationId: string) {
		this.#env = env;
		this.#cfg = cfg;
		this.#conversationId = conversationId;
	}

	async #machineId(): Promise<string> {
		return ensureMachine(this.#env, this.#cfg, this.#conversationId);
	}

	async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
		const id = await this.#machineId();
		return execOnce(this.#cfg, id, cmd, opts);
	}

	async execStream(cmd: string, opts: ExecOptions = {}): Promise<ExecStream> {
		const result = await this.exec(cmd, opts);
		return streamFromResult(result);
	}

	async runCode(
		code: string,
		opts: { language: RunCodeLanguage; timeout?: number },
	): Promise<RunCodeResult> {
		const id = await this.#machineId();
		const r = await runCodeShell(this.#cfg, id, code, opts.language, opts.timeout);
		const logs = {
			stdout: r.stdout ? r.stdout.split('\n').filter((l, i, arr) => i < arr.length - 1 || l) : [],
			stderr: r.stderr ? r.stderr.split('\n').filter((l, i, arr) => i < arr.length - 1 || l) : [],
		};
		if (r.exitCode !== 0) {
			return {
				results: [],
				logs,
				error: {
					name: 'RuntimeError',
					message: r.stderr.split('\n').slice(-1)[0] || `Exited with code ${r.exitCode}`,
					traceback: r.stderr ? r.stderr.split('\n') : undefined,
				},
			};
		}
		return { results: [], logs };
	}

	async readFile(path: string): Promise<ReadFileResult> {
		const id = await this.#machineId();
		return readFileShell(this.#cfg, id, path);
	}

	async writeFile(path: string, content: string): Promise<void> {
		const id = await this.#machineId();
		await writeFileShell(this.#cfg, id, path, content);
	}

	async deleteFile(path: string): Promise<void> {
		const id = await this.#machineId();
		await deleteFileShell(this.#cfg, id, path);
	}

	async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
		const id = await this.#machineId();
		await mkdirShell(this.#cfg, id, path, !!opts.recursive);
	}

	async exists(path: string): Promise<{ exists: boolean }> {
		const id = await this.#machineId();
		return existsShell(this.#cfg, id, path);
	}

	async exposePort(port: number, opts: { hostname: string; token: string }): Promise<void> {
		// Fly's HTTP service is statically declared; the in-container
		// reverse proxy peels the port off the Host header. Recording the
		// (port, token) tuple here just lets getExposedPorts reconstruct
		// the URL list later. The hostname is taken from the live request
		// at list-time, so we don't persist it.
		await recordExposedPort(this.#env, this.#conversationId, port, opts.token);
	}

	async getExposedPorts(hostname: string): Promise<ExposedPort[]> {
		return listExposedPorts(this.#env, this.#conversationId, hostname);
	}

	async destroy(): Promise<void> {
		await destroyManagedMachine(this.#env, this.#cfg, this.#conversationId);
		await clearExposedPorts(this.#env, this.#conversationId);
	}

	async fetch(request: Request): Promise<Response> {
		// Look up the machine id (cached). If we don't have one yet, return
		// 503 — previews require an existing sandbox, and ensureMachine
		// from the preview hot path would cost 5-10s on cold start.
		const machineId = await getCachedMachineId(this.#env, this.#conversationId);
		if (!machineId) {
			return new Response('sandbox not initialized', { status: 503 });
		}

		const inboundUrl = new URL(request.url);
		const targetUrl = `https://${this.#cfg.appHostname}${inboundUrl.pathname}${inboundUrl.search}`;
		const headers = new Headers(request.headers);
		// Pin routing to this conversation's machine. fly's edge honors
		// this as a strong hint; if the machine is stopped, fly will
		// autostart it (declared via `autostart: true` on the service).
		headers.set('fly-prefer-instance-id', machineId);
		// Preserve the original Host so the in-container reverse proxy can
		// peel the leading `${port}-` off and route to localhost:port.
		headers.set('Host', inboundUrl.host);

		const init: RequestInit = {
			method: request.method,
			headers,
			redirect: 'manual',
		};
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			init.body = request.body;
			(init as RequestInit & { duplex?: string }).duplex = 'half';
		}
		return fetch(targetUrl, init);
	}
}

export const flyBackend: SandboxBackend = {
	id: 'fly',
	isAvailable(env: Env): boolean {
		return flyConfigFromEnv(env) !== null;
	},
	get(env: Env, conversationId: string): SandboxInstance {
		const cfg = flyConfigFromEnv(env);
		if (!cfg) {
			throw new Error('Fly backend not configured (set FLY_API_TOKEN and FLY_APP_NAME).');
		}
		return new FlySandboxInstance(env, cfg, conversationId);
	},
};
