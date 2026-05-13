// Backend registry and selection. Reads the user's `sandbox_backend`
// setting, validates availability (binding/secrets present), and returns
// the matching SandboxInstance — falling back to any available backend if
// the user's preferred one is unconfigured, or `null` if none are.

import { getSandboxBackendId } from '$lib/server/settings';
import type { SandboxBackend, SandboxBackendId, SandboxInstance } from './backend';
import { cloudflareBackend } from './cloudflare';
import { flyBackend } from './fly/backend';

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

// Short-lived per-isolate cache of the resolved backend selection. When
// both backends are configured, a single sandbox tool call invokes
// `getConversationSandbox` up to four times (workspace setup, SSH key
// injection, the tool body, and the post-call R2 flush). Without this
// cache each invocation would re-read `sandbox_backend` from D1, even
// though the user can't realistically change the setting mid-tool-call.
// 30s is long enough to coalesce all four within one tool call (and
// across rapid follow-ups) yet short enough that a Settings UI flip
// takes effect by the next turn.
const SELECTION_TTL_MS = 30_000;
const SELECTION_CACHE_MAX = 64;
type SelectionEntry = { backendId: SandboxBackendId; expiresAt: number };
const selectionCache = new Map<string, SelectionEntry>();

function rememberSelection(key: string, backendId: SandboxBackendId): void {
	if (selectionCache.size >= SELECTION_CACHE_MAX) {
		const first = selectionCache.keys().next().value;
		if (first !== undefined) selectionCache.delete(first);
	}
	selectionCache.set(key, { backendId, expiresAt: Date.now() + SELECTION_TTL_MS });
}

// Test helper: wipe the cache between tests so a setting change isn't
// hidden by a stale entry.
export function _resetBackendSelectionCache(): void {
	selectionCache.clear();
}

export async function getBackend(env: Env, userId?: number): Promise<SandboxBackend | null> {
	const available = FALLBACK_ORDER.map((id) => BACKENDS[id]).filter((b) => b.isAvailable(env));
	if (available.length === 0) return null;
	if (available.length === 1) return available[0];
	// Multiple backends are available — consult the user setting to pick.
	// (Tests that don't configure D1 will never hit this branch because
	// they don't configure any backend either.)
	const cacheKey = String(userId ?? '');
	const cached = selectionCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return available.find((b) => b.id === cached.backendId) ?? available[0];
	}
	const preferred = await getSandboxBackendId(env, userId);
	const backend = available.find((b) => b.id === preferred) ?? available[0];
	rememberSelection(cacheKey, backend.id);
	return backend;
}

export async function getSandboxInstance(env: Env, conversationId: string, userId?: number): Promise<SandboxInstance | null> {
	const backend = await getBackend(env, userId);
	if (!backend) return null;
	return backend.get(env, conversationId);
}
