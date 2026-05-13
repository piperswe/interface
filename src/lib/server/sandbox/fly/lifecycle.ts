// Per-conversation fly Machine lifecycle.
//
// On first network-touching call we look up the existing machine id in
// D1; if missing we create one; if present but stopped we start it. The
// machine id is cached in an isolate-local LRU so the preview hot path
// (which also needs the id, to set `fly-prefer-instance-id`) doesn't pay
// the D1 round-trip on every request.

import { clearFlyMachineId, getFlyMachineId, setFlyMachineId } from './d1';
import {
	createMachine,
	destroyMachine,
	type FlyConfig,
	type FlyMachineConfig,
	getMachine,
	startMachine,
	waitForMachineState,
} from './machines-api';

// Image: pushed to fly's per-app registry by CI. The convention here
// matches `scripts/build-fly-image.sh` / `flyctl deploy`.
function imageFor(cfg: FlyConfig): string {
	return `registry.fly.io/${cfg.appName}:deployment-01KRHEYB5R4VQSXGX2H4ZHQVTQ`;
}

function defaultMachineConfig(cfg: FlyConfig, conversationId: string): FlyMachineConfig {
	return {
		auto_destroy: false,
		// Inject the conversation id so the in-container preview proxy
		// can validate inbound Host headers against it. Without this,
		// any request that reaches the machine (e.g. via a missing
		// fly-prefer-instance-id header that fly load-balances to a
		// stranger machine) would be forwarded to whatever localhost
		// port the Host's leading digits resolve to, regardless of
		// whether that conversation owns the machine.
		env: { SANDBOX_CONVERSATION_ID: conversationId },
		image: imageFor(cfg),
		restart: { max_retries: 3, policy: 'on-failure' },
		services: [
			{
				autostart: true,
				// Let fly's proxy idle-stop the machine; ensureMachine wakes
				// it back up before each exec/file call.
				autostop: 'stop',
				internal_port: 8080,
				// Single public HTTP service. The in-container reverse
				// proxy (started by scripts/fly-entrypoint.sh) listens on
				// :8080 and routes by Host header: requests with host
				// `${port}-${conversationId}-${token}.${appHostname}` are
				// forwarded to localhost:${port}.
				ports: [
					{ handlers: ['http'], port: 80 },
					{ handlers: ['tls', 'http'], port: 443 },
				],
				protocol: 'tcp',
			},
		],
	};
}

// Isolate-local cache of `conversationId -> machineId`. Same bounded-LRU
// pattern as the SSH-key cache in tools/sandbox.ts.
const MACHINE_CACHE_MAX = 256;
const machineCache = new Map<string, string>();

// In-flight `ensureMachine` promises keyed by conversation id. Without
// this, two concurrent tool calls for the same conversation on the same
// isolate (e.g. a sub-agent + parent agent both hitting sandbox tools)
// would both see `machineId = null` and both POST /machines, leaking the
// second machine. Coalescing collapses the duplicate work to a single
// API call. Cross-isolate races (rare given ConversationDurableObject
// pins a conversation to a single isolate) are mitigated by the
// post-create reconciliation step inside `ensureMachineInner`.
const inFlight = new Map<string, Promise<string>>();

function rememberMachine(conversationId: string, machineId: string): void {
	if (machineCache.size >= MACHINE_CACHE_MAX) {
		const first = machineCache.keys().next().value;
		if (first !== undefined) machineCache.delete(first);
	}
	machineCache.set(conversationId, machineId);
}

function forgetMachine(conversationId: string): void {
	machineCache.delete(conversationId);
}

export async function getCachedMachineId(env: Env, conversationId: string): Promise<string | null> {
	const cached = machineCache.get(conversationId);
	if (cached) return cached;
	const fromDb = await getFlyMachineId(env, conversationId);
	if (fromDb) rememberMachine(conversationId, fromDb);
	return fromDb;
}

export async function ensureMachine(env: Env, cfg: FlyConfig, conversationId: string): Promise<string> {
	const existing = inFlight.get(conversationId);
	if (existing) return existing;
	const promise = ensureMachineInner(env, cfg, conversationId).finally(() => {
		inFlight.delete(conversationId);
	});
	inFlight.set(conversationId, promise);
	return promise;
}

async function ensureMachineInner(env: Env, cfg: FlyConfig, conversationId: string): Promise<string> {
	let machineId = await getCachedMachineId(env, conversationId);

	if (machineId) {
		const machine = await getMachine(cfg, machineId);
		if (!machine) {
			// Externally destroyed (operator action, fly cleanup). Drop the
			// stale id and fall through to create a new one.
			await clearFlyMachineId(env, conversationId);
			forgetMachine(conversationId);
			machineId = null;
		} else if (machine.state === 'stopped' || machine.state === 'suspended' || machine.state === 'created') {
			if (machine.state !== 'created') {
				await startMachine(cfg, machineId);
			}
			await waitForMachineState(cfg, machineId, 'started', 20);
		} else if (machine.state === 'destroyed' || machine.state === 'destroying') {
			await clearFlyMachineId(env, conversationId);
			forgetMachine(conversationId);
			machineId = null;
		}
		// 'started', 'starting', 'replacing' — assume ready (the next API
		// call will surface any issues).
	}

	if (!machineId) {
		// Cross-isolate race mitigation: between this check and the
		// createMachine call below, another isolate could create a machine
		// and write its id to D1. After we create, re-read D1; if a
		// different id is now present, prefer it and destroy our orphan.
		const created = await createMachine(cfg, {
			config: defaultMachineConfig(cfg, conversationId),
			name: `sandbox-${conversationId.slice(0, 24)}`,
		});
		machineId = created.id;
		const existingInDb = await getFlyMachineId(env, conversationId);
		if (existingInDb && existingInDb !== machineId) {
			try {
				await destroyMachine(cfg, machineId);
			} catch {
				/* best-effort */
			}
			machineId = existingInDb;
		} else {
			await setFlyMachineId(env, conversationId, machineId);
		}
		rememberMachine(conversationId, machineId);
		// Newly created machines start automatically; wait for ready.
		try {
			await waitForMachineState(cfg, machineId, 'started', 30);
		} catch {
			// Don't fail the call if the wait endpoint races the state
			// transition — the next exec/file op will throw a more
			// actionable error if the machine never started.
		}
	}

	return machineId;
}

export async function destroyManagedMachine(env: Env, cfg: FlyConfig, conversationId: string): Promise<void> {
	const machineId = await getCachedMachineId(env, conversationId);
	if (!machineId) return;
	try {
		await destroyMachine(cfg, machineId);
	} catch {
		/* idempotent — operator destroys, network blips */
	}
	await clearFlyMachineId(env, conversationId);
	forgetMachine(conversationId);
}
