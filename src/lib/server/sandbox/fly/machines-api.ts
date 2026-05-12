// Thin REST client for fly.io's Machines API.
// https://fly.io/docs/machines/api/
//
// All requests use the public endpoint (api.machines.dev), so this runs
// from a Cloudflare Worker without any private-network/WireGuard setup.
// Token is passed via `Authorization: Bearer ${FLY_API_TOKEN}`.
//
// Type-safety strategy: every value crossing the fly.io boundary —
// inbound responses and outbound request bodies — is described by a Zod
// schema. Inbound responses are parsed via `safeParse` so a fly API
// drift surfaces as a `FlyApiError` with the validation issues rather
// than a silent `as` cast that the rest of the code base trusts. The
// public TypeScript types (`FlyMachine`, `FlyMachineConfig`,
// `FlyExecRequest`, `FlyExecResponse`) are derived from the schemas
// with `z.infer<...>`, so the runtime check and the static type stay in
// lockstep.

import { z } from 'zod';
import { formatZodError } from '$lib/zod-utils';

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

// ----- Wire-level schemas --------------------------------------------------
//
// Schemas describe only the fields we actually consume — fly's API
// returns plenty of additional metadata (image, vcpu/memory, instance
// counters, etc.) that we ignore. The default zod `object` is "passthrough
// unknown keys at parse time, strip them on output", which is what we
// want: extra fields from fly don't break us, but they also don't leak
// into our typed surface area.

export const flyMachineStateSchema = z.enum([
	'created',
	'starting',
	'started',
	'stopping',
	'stopped',
	'suspending',
	'suspended',
	'replacing',
	'destroying',
	'destroyed',
]);
export type FlyMachineState = z.infer<typeof flyMachineStateSchema>;

export const flyMachineSchema = z.object({
	id: z.string(),
	state: flyMachineStateSchema,
	region: z.string().optional(),
	private_ip: z.string().optional(),
});
export type FlyMachine = z.infer<typeof flyMachineSchema>;

const flyServicePortSchema = z.object({
	port: z.number().int().positive(),
	handlers: z.array(z.string()).optional(),
	force_https: z.boolean().optional(),
});

const flyServiceSchema = z.object({
	ports: z.array(flyServicePortSchema),
	protocol: z.enum(['tcp', 'udp']),
	internal_port: z.number().int().positive(),
	autostop: z.enum(['off', 'suspend', 'stop']).optional(),
	autostart: z.boolean().optional(),
});

const flyMountSchema = z.object({
	path: z.string(),
	volume: z.string().optional(),
	name: z.string().optional(),
	size_gb: z.number().int().positive().optional(),
});

const flyRestartSchema = z.object({
	policy: z.enum(['no', 'always', 'on-failure']),
	max_retries: z.number().int().nonnegative().optional(),
});

export const flyMachineConfigSchema = z.object({
	image: z.string(),
	env: z.record(z.string(), z.string()).optional(),
	services: z.array(flyServiceSchema).optional(),
	mounts: z.array(flyMountSchema).optional(),
	restart: flyRestartSchema.optional(),
	auto_destroy: z.boolean().optional(),
});
export type FlyMachineConfig = z.infer<typeof flyMachineConfigSchema>;

const flyCreateMachineRequestSchema = z.object({
	config: flyMachineConfigSchema,
	name: z.string().optional(),
	region: z.string().optional(),
});
export type FlyCreateMachineRequest = z.infer<typeof flyCreateMachineRequestSchema>;

export const flyExecRequestSchema = z.object({
	// Full argv. We always shell out via `bash -lc` so the caller can pass
	// a single command string; see `lifecycle.ts`.
	cmd: z.array(z.string()).min(1),
	// Server-side timeout in seconds.
	timeout: z.number().int().positive().optional(),
	// Optional stdin payload as a string. (Fly's API also accepts
	// base64-encoded stdin for binary; we use string form because we
	// control all callers and they only push text.)
	stdin: z.string().optional(),
});
export type FlyExecRequest = z.infer<typeof flyExecRequestSchema>;

export const flyExecResponseSchema = z.object({
	exit_code: z.number().int(),
	exit_signal: z.number().int().optional(),
	// fly's API occasionally returns `null` instead of `""` for empty
	// output streams; tolerate both and normalise downstream callers'
	// view to a string.
	stdout: z.string().nullable().optional().transform((v) => v ?? ''),
	stderr: z.string().nullable().optional().transform((v) => v ?? ''),
});
export type FlyExecResponse = z.infer<typeof flyExecResponseSchema>;

// ----- HTTP plumbing ------------------------------------------------------

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
	return fetch(`${FLY_API_BASE}${path}`, { ...init, headers });
}

// JSON body builder. Validating outbound bodies catches local mistakes
// before they cost us a round-trip (e.g. a stray undefined sneaking into
// a required field). The parsed value is the one sent on the wire.
function jsonBody<S extends z.ZodTypeAny>(schema: S, value: z.input<S>): string {
	const parsed = schema.parse(value);
	return JSON.stringify(parsed);
}

// Read & validate a fly JSON response. Throws `FlyApiError` for HTTP
// failures and for shape drift. Empty responses are allowed only when
// the caller passes a schema that accepts `undefined` (e.g. the `void`
// schemas used by `startMachine` / `waitForMachineState`).
async function flyJson<S extends z.ZodTypeAny>(
	cfg: FlyConfig,
	path: string,
	schema: S,
	init: RequestInit = {},
): Promise<z.infer<S>> {
	const resp = await flyFetch(cfg, path, init);
	const text = await resp.text();
	const method = init.method ?? 'GET';
	if (!resp.ok) {
		throw new FlyApiError(`Fly API ${method} ${path} → ${resp.status}`, resp.status, text);
	}
	let parsedJson: unknown = undefined;
	if (text) {
		try {
			parsedJson = JSON.parse(text);
		} catch {
			throw new FlyApiError(
				`Fly API ${method} ${path}: non-JSON response`,
				resp.status,
				text,
			);
		}
	}
	const result = schema.safeParse(parsedJson);
	if (!result.success) {
		throw new FlyApiError(
			`Fly API ${method} ${path}: response failed validation (${formatZodError(result.error)})`,
			resp.status,
			text,
		);
	}
	return result.data;
}

// Endpoints that return `{}` (or empty body). We don't care about the
// shape — just want a schema that parses any JSON object or undefined
// without complaining.
const flyEmptyResponseSchema = z.unknown();

// ----- Endpoint helpers ---------------------------------------------------

export async function getMachine(cfg: FlyConfig, machineId: string): Promise<FlyMachine | null> {
	const resp = await flyFetch(cfg, `/apps/${cfg.appName}/machines/${machineId}`);
	if (resp.status === 404) return null;
	const text = await resp.text();
	if (!resp.ok) {
		throw new FlyApiError(`Fly API GET machine ${machineId} → ${resp.status}`, resp.status, text);
	}
	let parsedJson: unknown;
	try {
		parsedJson = text ? JSON.parse(text) : undefined;
	} catch {
		throw new FlyApiError(`Fly API GET machine ${machineId}: non-JSON response`, resp.status, text);
	}
	const result = flyMachineSchema.safeParse(parsedJson);
	if (!result.success) {
		throw new FlyApiError(
			`Fly API GET machine ${machineId}: response failed validation (${formatZodError(result.error)})`,
			resp.status,
			text,
		);
	}
	return result.data;
}

export async function createMachine(
	cfg: FlyConfig,
	body: FlyCreateMachineRequest,
): Promise<FlyMachine> {
	return flyJson(cfg, `/apps/${cfg.appName}/machines`, flyMachineSchema, {
		method: 'POST',
		body: jsonBody(flyCreateMachineRequestSchema, body),
	});
}

export async function startMachine(cfg: FlyConfig, machineId: string): Promise<void> {
	await flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/start`, flyEmptyResponseSchema, {
		method: 'POST',
	});
}

export async function waitForMachineState(
	cfg: FlyConfig,
	machineId: string,
	state: FlyMachineState,
	timeoutSeconds = 20,
): Promise<void> {
	await flyJson(
		cfg,
		`/apps/${cfg.appName}/machines/${machineId}/wait?state=${state}&timeout=${timeoutSeconds}`,
		flyEmptyResponseSchema,
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
	return flyJson(cfg, `/apps/${cfg.appName}/machines/${machineId}/exec`, flyExecResponseSchema, {
		method: 'POST',
		body: jsonBody(flyExecRequestSchema, body),
	});
}
