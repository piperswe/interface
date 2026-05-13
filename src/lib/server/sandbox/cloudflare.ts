// Cloudflare Containers / Sandbox DO adapter.
//
// Mostly delegation to `@cloudflare/sandbox`. The notable wrinkle is
// `execStream`: the SDK returns an HTTP Response whose body is SSE; we
// adapt that to the backend-agnostic `AsyncIterable<ExecEvent>` shape,
// preserving the regression-protection contract documented in
// `tools/sandbox.ts:565-686` — the consumer's `cancel()` aborts the SSE
// reader signal but does NOT await `reader.cancel()`, because cancel
// propagation across the Sandbox-DO RPC boundary can hang.

import type { Sandbox, ExecEvent as SdkExecEvent } from '@cloudflare/sandbox';
import { getSandbox, parseSSEStream } from '@cloudflare/sandbox';
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
} from './backend';

const SLEEP_AFTER = '1h';

type SdkSandbox = ReturnType<typeof getSandbox>;

function getSdkSandbox(env: Env, conversationId: string): SdkSandbox {
	const ns = env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>;
	return getSandbox(ns, conversationId, { sleepAfter: SLEEP_AFTER });
}

// Exported so the DO sandbox helper can keep its existing test seam — the
// SDK return shape drifts across versions, so we defensively normalise both
// array and `{ ports }` object forms.
export async function _listExposedPorts(
	sandbox: { getExposedPorts: (hostname: string) => Promise<unknown> },
	hostname: string,
): Promise<ExposedPort[]> {
	const result = await sandbox.getExposedPorts(hostname);
	const ports = Array.isArray(result) ? result : ((result as { ports?: unknown[] }).ports ?? []);
	return (ports as Array<{ port: number; url: string; name?: string }>).map((p) => ({
		name: p.name,
		port: p.port,
		url: p.url,
	}));
}

function mapSdkEvent(ev: SdkExecEvent): ExecEvent | null {
	switch (ev.type) {
		case 'stdout':
		case 'stderr':
			return { data: ev.data ?? '', type: ev.type };
		case 'complete':
			return { exitCode: ev.exitCode ?? 0, type: 'complete' };
		case 'error':
			return { data: ev.data, error: ev.error, type: 'error' };
		default:
			// 'start' (and any future SDK-only event types) — the consumer
			// in `tools/sandbox.ts` doesn't branch on them. Drop.
			return null;
	}
}

function makeExecStream(stream: ReadableStream<Uint8Array>): ExecStream {
	const ac = new AbortController();
	// The for-await in the consumer runs the SSE generator's `finally`
	// (which `await reader.cancel()`s the underlying body). Across the
	// Sandbox-DO RPC boundary that cancel can hang, so we don't expose
	// any direct awaitable cancel — the consumer aborts the signal we
	// pass to parseSSEStream and floats the iterator; the container's
	// idle timeout eventually cleans up. The Promise returned by our
	// `cancel()` resolves immediately for the same reason.
	const sdkIter: AsyncIterable<SdkExecEvent> = parseSSEStream<SdkExecEvent>(stream, ac.signal);
	const adapter: AsyncIterable<ExecEvent> = {
		async *[Symbol.asyncIterator]() {
			for await (const ev of sdkIter) {
				const mapped = mapSdkEvent(ev);
				if (mapped) yield mapped;
			}
		},
	};
	return Object.assign(adapter, {
		async cancel() {
			ac.abort();
		},
	});
}

class CloudflareSandboxInstance implements SandboxInstance {
	#env: Env;
	#conversationId: string;
	#sdk: SdkSandbox | null = null;

	constructor(env: Env, conversationId: string) {
		this.#env = env;
		this.#conversationId = conversationId;
	}

	#sandbox(): SdkSandbox {
		if (!this.#sdk) this.#sdk = getSdkSandbox(this.#env, this.#conversationId);
		return this.#sdk;
	}

	async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
		const result = await this.#sandbox().exec(cmd, opts);
		return {
			exitCode: result.exitCode,
			stderr: result.stderr,
			stdout: result.stdout,
			success: result.success,
		};
	}

	async execStream(cmd: string, opts: ExecOptions = {}): Promise<ExecStream> {
		// NOTE: ctx.signal intentionally not forwarded — AbortSignal serialization
		// over Durable Object RPC requires the experimental
		// `enable_abortsignal_rpc` compatibility flag. The signal is honored
		// when iterating the SSE stream via `makeExecStream`.
		const stream = await this.#sandbox().execStream(cmd, opts);
		return makeExecStream(stream);
	}

	async runCode(code: string, opts: { language: RunCodeLanguage; timeout?: number }): Promise<RunCodeResult> {
		return (await this.#sandbox().runCode(code, opts)) as RunCodeResult;
	}

	async readFile(path: string): Promise<ReadFileResult> {
		const file = await this.#sandbox().readFile(path);
		return {
			content: file.content,
			encoding: file.encoding === 'base64' ? 'base64' : 'utf8',
		};
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.#sandbox().writeFile(path, content);
	}

	async deleteFile(path: string): Promise<void> {
		await this.#sandbox().deleteFile(path);
	}

	async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
		await this.#sandbox().mkdir(path, { recursive: !!opts.recursive });
	}

	async exists(path: string): Promise<{ exists: boolean }> {
		const result = await this.#sandbox().exists(path);
		return { exists: !!result.exists };
	}

	async exposePort(port: number, opts: { hostname: string; token: string }): Promise<void> {
		await this.#sandbox().exposePort(port, opts);
	}

	async getExposedPorts(hostname: string): Promise<ExposedPort[]> {
		return _listExposedPorts(this.#sandbox() as unknown as { getExposedPorts: (h: string) => Promise<unknown> }, hostname);
	}

	async destroy(): Promise<void> {
		try {
			await this.#sandbox().destroy();
		} catch {
			/* idempotent */
		}
	}

	async fetch(request: Request): Promise<Response> {
		const ns = this.#env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>;
		const id = ns.idFromName(this.#conversationId);
		const stub = ns.get(id);
		return await stub.fetch(request);
	}
}

export const cloudflareBackend: SandboxBackend = {
	get(env: Env, conversationId: string): SandboxInstance {
		return new CloudflareSandboxInstance(env, conversationId);
	},
	id: 'cloudflare',
	isAvailable(env: Env): boolean {
		return !!env.SANDBOX;
	},
};
