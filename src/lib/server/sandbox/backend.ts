// Backend-agnostic sandbox interface.
//
// Concrete implementations live in `./cloudflare.ts` (wraps @cloudflare/sandbox)
// and `./fly/` (talks to the fly.io Machines REST + WebSocket exec API).
// Consumers (`tools/sandbox.ts`, `durable_objects/conversation/sandbox.ts`,
// the preview route) should depend on this module only, never on the
// concrete SDKs.

export type ExecOptions = {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
	timeout?: number;
};

export type ExecResult = {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
};

export type ExecEvent =
	| { type: 'stdout'; data: string }
	| { type: 'stderr'; data: string }
	| { type: 'complete'; exitCode: number }
	| { type: 'error'; data?: string; error?: string };

export type RunCodeLanguage = 'python' | 'javascript' | 'typescript';

export type RunCodeResult = {
	results: Array<{
		text?: string;
		html?: string;
		json?: unknown;
		png?: string;
		jpeg?: string;
		svg?: string;
		markdown?: string;
	}>;
	logs: { stdout: string[]; stderr: string[] };
	error?: { name: string; message: string; traceback?: string[] };
};

export type ReadFileResult = { content: string; encoding: 'utf8' | 'base64' };
export type ExistsResult = { exists: boolean };
export type ExposedPort = { port: number; url: string; name?: string };

export type ExecStream = AsyncIterable<ExecEvent> & {
	cancel(): Promise<void>;
};

// Per-conversation sandbox handle. Methods may be called multiple times on
// the same instance; backends are responsible for any lifecycle bookkeeping
// (cold-start, machine creation, etc.) behind the scenes.
export interface SandboxInstance {
	exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
	execStream(cmd: string, opts?: ExecOptions): Promise<ExecStream>;
	runCode(
		code: string,
		opts: { language: RunCodeLanguage; timeout?: number },
	): Promise<RunCodeResult>;
	readFile(path: string): Promise<ReadFileResult>;
	writeFile(path: string, content: string): Promise<void>;
	deleteFile(path: string): Promise<void>;
	mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
	exists(path: string): Promise<ExistsResult>;
	exposePort(port: number, opts: { hostname: string; token: string }): Promise<void>;
	getExposedPorts(hostname: string): Promise<ExposedPort[]>;
	destroy(): Promise<void>;
	// Preview proxy entry point. The route handler builds a sanitized
	// Request whose URL host is `{port}-{conversationId}-{token}.{host}`;
	// the backend forwards it to the sandbox process listening on that
	// port. Cloudflare goes directly to the Sandbox DO; fly routes through
	// the public app with a `fly-prefer-instance-id` header.
	fetch(request: Request): Promise<Response>;
}

export type SandboxBackendId = 'cloudflare' | 'fly';

export interface SandboxBackend {
	readonly id: SandboxBackendId;
	// Returns true when the operator has configured the prerequisites for
	// this backend (Cloudflare: SANDBOX binding present. Fly: FLY_API_TOKEN
	// + FLY_APP_NAME secrets present).
	isAvailable(env: Env): boolean;
	get(env: Env, conversationId: string): SandboxInstance;
}
