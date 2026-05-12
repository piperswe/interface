// Backend registry and selection. Reads the user's `sandbox_backend`
// setting, validates availability (binding/secrets present), and returns
// the matching SandboxInstance — falling back to any available backend if
// the user's preferred one is unconfigured, or `null` if none are.

import { getSandboxBackendId } from '$lib/server/settings';
import { cloudflareBackend } from './cloudflare';
import { flyBackend } from './fly/backend';
import type { SandboxBackend, SandboxBackendId, SandboxInstance } from './backend';

export type { SandboxBackend, SandboxBackendId, SandboxInstance } from './backend';

const BACKENDS: Record<SandboxBackendId, SandboxBackend> = {
	cloudflare: cloudflareBackend,
	fly: flyBackend,
};

// All registered backends. Order is the fallback priority when the user's
// selected backend is unavailable.
const FALLBACK_ORDER: SandboxBackendId[] = ['cloudflare', 'fly'];

export function listBackends(): SandboxBackend[] {
	return FALLBACK_ORDER.map((id) => BACKENDS[id]);
}

export async function getBackend(env: Env, userId?: number): Promise<SandboxBackend | null> {
	const available = FALLBACK_ORDER.map((id) => BACKENDS[id]).filter((b) => b.isAvailable(env));
	if (available.length === 0) return null;
	if (available.length === 1) return available[0];
	// Multiple backends are available — consult the user setting to pick.
	// (Tests that don't configure D1 will never hit this branch because
	// they don't configure any backend either.)
	const preferred = await getSandboxBackendId(env, userId);
	return available.find((b) => b.id === preferred) ?? available[0];
}

export async function getSandboxInstance(
	env: Env,
	conversationId: string,
	userId?: number,
): Promise<SandboxInstance | null> {
	const backend = await getBackend(env, userId);
	if (!backend) return null;
	return backend.get(env, conversationId);
}
