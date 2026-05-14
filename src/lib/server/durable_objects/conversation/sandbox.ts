import { getSandboxInstance, listBackends } from '$lib/server/sandbox';
import type { ExposedPort } from '$lib/server/sandbox/backend';

// The exposed-ports normalisation lives with its real consumer (the
// Cloudflare backend adapter). Re-exported here so this module's unit
// tests can keep their existing test seam.
export { _listExposedPorts } from '$lib/server/sandbox/cloudflare';

export async function getSandboxPreviewPorts(env: Env, conversationId: string | null, hostname: string): Promise<ExposedPort[]> {
	if (!conversationId) return [];
	try {
		const instance = await getSandboxInstance(env, conversationId);
		if (!instance) return [];
		return await instance.getExposedPorts(hostname);
	} catch {
		return [];
	}
}

// Destroy the sandbox for *every* available backend, not just the
// currently-selected one. A user can switch backends mid-life of a
// conversation (e.g. cloudflare → fly → cloudflare), and on
// conversation deletion we must clean up resources on each backend
// they ever used — otherwise fly machines (created with
// `auto_destroy: false`) leak indefinitely and the `conversation_sandbox`
// D1 rows pile up. `.destroy()` is idempotent on both backends, so
// invoking it on a backend that never held state for this conversation
// is a cheap no-op.
export async function destroySandbox(env: Env, conversationId: string | null): Promise<void> {
	if (!conversationId) return;
	for (const backend of listBackends()) {
		if (!backend.isAvailable(env)) continue;
		try {
			await backend.get(env, conversationId).destroy();
		} catch {
			/* one backend's failure shouldn't block the others */
		}
	}
}
