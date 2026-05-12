// Thin REST client for fly.io's Machines API.
// https://fly.io/docs/machines/api/
//
// All requests use the public endpoint (api.machines.dev), so this runs
// from a Cloudflare Worker without any private-network/WireGuard setup.
// Token is passed via `Authorization: Bearer ${FLY_API_TOKEN}`.

const FLY_API_BASE = 'https://api.machines.dev/v1';

export type FlyConfig = {
	token: string;
	appName: string;
	// Public hostname for the app (defaults to `${appName}.fly.dev`).
	appHostname: string;
};

export function flyConfigFromEnv(env: Env): FlyConfig | null {
	const token = env.FLY_API_TOKEN;
	const appName = env.FLY_APP_NAME;
	if (!token || !appName) return null;
	return {
		token,
		appName,
		appHostname: env.FLY_APP_HOSTNAME ?? `${appName}.fly.dev`,
	};
}

export class FlyApiError extends Error {
	status: number;
	body: string;
	constructor(message: string, status: number, body: string) {
		super(message);
		this.name = 'FlyApiError';
		this.status = status;
		this.body = body;
	}
}

async function flyFetch(
	cfg: FlyConfig,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers ?? {});
	headers.set('Authorization', `Bearer ${cfg.token}`);
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}
	const resp = await fetch(`${FLY_API_BASE}${path}`, { ...init, headers });
	return resp;
}

async function flyJson<T>(cfg: FlyConfig, path: string, init: RequestInit = {}): Promise<T> {
	const resp = await flyFetch(cfg, path, init);
	const text = await resp.text();
	if (!resp.ok) {
		throw new FlyApiError(`Fly API ${init.method ?? 'GET'} ${path} → ${resp.status}`, resp.status, text);
	}
	if (!text) return undefined as unknown as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new FlyApiError(
			`Fly API ${init.method ?? 'GET'} ${path}: non-JSON response`,
			resp.status,
			text,
		);
	}
}

export type FlyMachineState =
	| 'created'
	| 'starting'
	| 'started'
	| 'stopping'
	| 'stopped'
	| 'suspending'
	| 'suspended'
	| 'replacing'
	| 'destroying'
	| 'destroyed';

export type FlyMachine = {
	id: string;
	state: FlyMachineState;
	region?: string;
	private_ip?: string;
};

export type FlyMachineConfig = {
	image: string;
	env?: Record<string, string>;
	services?: Array<{
		ports: Array<{ port: number; handlers?: string[]; force_https?: boolean }>;
		protocol: 'tcp' | 'udp';
		internal_port: number;
		autostop?: 'off' | 'suspend' | 'stop';
		autostart?: boolean;
	}>;
	mounts?: Array<{ path: string; volume?: string; name?: string; size_gb?: number }>;
	restart?: { policy: 'no' | 'always' | 'on-failure'; max_retries?: number };
	auto_destroy?: boolean;
};

export async function getMachine(cfg: FlyConfig, machineId: string): Promise<FlyMachine | null> {
	const resp = await flyFetch(cfg, `/apps/${cfg.appName}/machines/${machineId}`);
	if (resp.status === 404) return null;
	const text = await resp.text();
	if (!resp.ok) {
		throw new FlyApiError(`Fly API GET machine ${machineId} → ${resp.status}`, resp.status, text);
	}
	return JSON.parse(text) as FlyMachine;
}

export async function createMachine(
	cfg: FlyConfig,
	body: { config: FlyMachineConfig; name?: string; region?: string },
): Promise<FlyMachine> {
	return flyJson<FlyMachine>(cfg, `/apps/${cfg.appName}/machines`, {
		method: 'POST',
		body: JSON.stringify(body),
	});
}

export async function startMachine(cfg: FlyConfig, machineId: string): Promise<void> {
	await flyJson<unknown>(cfg, `/apps/${cfg.appName}/machines/${machineId}/start`, {
		method: 'POST',
	});
}

export async function waitForMachineState(
	cfg: FlyConfig,
	machineId: string,
	state: FlyMachineState,
	timeoutSeconds = 20,
): Promise<void> {
	await flyJson<unknown>(
		cfg,
		`/apps/${cfg.appName}/machines/${machineId}/wait?state=${state}&timeout=${timeoutSeconds}`,
	);
}

export async function destroyMachine(cfg: FlyConfig, machineId: string): Promise<void> {
	const resp = await flyFetch(cfg, `/apps/${cfg.appName}/machines/${machineId}?force=true`, {
		method: 'DELETE',
	});
	if (!resp.ok && resp.status !== 404) {
		throw new FlyApiError(`Fly API DELETE machine ${machineId} → ${resp.status}`, resp.status, await resp.text());
	}
}

export type FlyExecRequest = {
	// Full argv. We always shell out via `bash -lc` so the caller can pass a
	// single command string; see `lifecycle.ts`.
	cmd: string[];
	// Server-side timeout in seconds.
	timeout?: number;
	// Optional stdin payload as a string. (Fly's API also accepts
	// base64-encoded stdin for binary; we use string form because we control
	// all callers and they only push text.)
	stdin?: string;
};

export type FlyExecResponse = {
	exit_code: number;
	exit_signal?: number;
	stdout: string;
	stderr: string;
};

// Synchronous exec endpoint. Returns the full output once the command
// terminates server-side. We expose `execStream` on the SandboxInstance by
// emitting a single trailing chunk — fly's documented exec endpoint is
// not chunk-streamed over HTTP, and the WebSocket variant requires a
// different protocol that the openapi spec doesn't fully publish. This is
// a deliberate v1 trade-off (see Risk #1 in the plan).
export async function execMachine(
	cfg: FlyConfig,
	machineId: string,
	body: FlyExecRequest,
): Promise<FlyExecResponse> {
	return flyJson<FlyExecResponse>(cfg, `/apps/${cfg.appName}/machines/${machineId}/exec`, {
		method: 'POST',
		body: JSON.stringify(body),
	});
}
