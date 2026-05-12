// Per-conversation fly Machine lifecycle.
//
// On first network-touching call we look up the existing machine id in
// D1; if missing we create one; if present but stopped we start it. The
// machine id is cached in an isolate-local LRU so the preview hot path
// (which also needs the id, to set `fly-prefer-instance-id`) doesn't pay
// the D1 round-trip on every request.

import {
	createMachine,
	destroyMachine,
	getMachine,
	startMachine,
	waitForMachineState,
	type FlyConfig,
	type FlyMachineConfig,
} from './machines-api';
import { clearFlyMachineId, getFlyMachineId, setFlyMachineId } from './d1';

// Image: pushed to fly's per-app registry by CI. The convention here
// matches `scripts/build-fly-image.sh` / `flyctl deploy`.
function imageFor(cfg: FlyConfig): string {
	return `registry.fly.io/${cfg.appName}:latest`;
}

function defaultMachineConfig(cfg: FlyConfig): FlyMachineConfig {
	return {
		image: imageFor(cfg),
		services: [
			{
				// Single public HTTP service. The in-container reverse
				// proxy (started by scripts/fly-entrypoint.sh) listens on
				// :8080 and routes by Host header: requests with host
				// `${port}-${conversationId}-${token}.${appHostname}` are
				// forwarded to localhost:${port}.
				ports: [
					{ port: 80, handlers: ['http'] },
					{ port: 443, handlers: ['tls', 'http'], force_https: true },
				],
				protocol: 'tcp',
				internal_port: 8080,
				// Let fly's proxy idle-stop the machine; ensureMachine wakes
				// it back up before each exec/file call.
				autostop: 'stop',
				autostart: true,
			},
		],
		restart: { policy: 'on-failure', max_retries: 3 },
		auto_destroy: false,
	};
}

// Isolate-local cache of `conversationId -> machineId`. Same bounded-LRU
// pattern as the SSH-key cache in tools/sandbox.ts.
const MACHINE_CACHE_MAX = 256;
const machineCache = new Map<string, string>();

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

export async function getCachedMachineId(
	env: Env,
	conversationId: string,
): Promise<string | null> {
	const cached = machineCache.get(conversationId);
	if (cached) return cached;
	const fromDb = await getFlyMachineId(env, conversationId);
	if (fromDb) rememberMachine(conversationId, fromDb);
	return fromDb;
}

export async function ensureMachine(
	env: Env,
	cfg: FlyConfig,
	conversationId: string,
): Promise<string> {
	let machineId = await getCachedMachineId(env, conversationId);

	if (machineId) {
		const machine = await getMachine(cfg, machineId);
		if (!machine) {
			// Externally destroyed (operator action, fly cleanup). Drop the
			// stale id and fall through to create a new one.
			await clearFlyMachineId(env, conversationId);
			forgetMachine(conversationId);
			machineId = null;
		} else if (
			machine.state === 'stopped' ||
			machine.state === 'suspended' ||
			machine.state === 'created'
		) {
			await startMachine(cfg, machineId);
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
		const created = await createMachine(cfg, {
			name: `sandbox-${conversationId.slice(0, 24)}`,
			config: defaultMachineConfig(cfg),
		});
		machineId = created.id;
		await setFlyMachineId(env, conversationId, machineId);
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

export async function destroyManagedMachine(
	env: Env,
	cfg: FlyConfig,
	conversationId: string,
): Promise<void> {
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
