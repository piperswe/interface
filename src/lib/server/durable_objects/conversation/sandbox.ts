import { getSandboxInstance, listBackends } from '$lib/server/sandbox';
import type { ExposedPort } from '$lib/server/sandbox/backend';

// Exported for unit testing — lets tests inject a fake sandbox without
// needing the Cloudflare SDK at all.
export async function _listExposedPorts(
	sandbox: { getExposedPorts: (hostname: string) => Promise<unknown> },
	hostname: string,
): Promise<ExposedPort[]> {
	// The Sandbox SDK return shape drifts across versions; defensively
	// normalise both array and object shapes here so legacy fakes in the
	// test suite keep pinning the contract. The Cloudflare backend's
	// adapter delegates to this same helper internally.
	const result = await sandbox.getExposedPorts(hostname);
	const ports = Array.isArray(result) ? result : ((result as { ports?: unknown[] }).ports ?? []);
	return (ports as Array<{ port: number; url: string; name?: string }>).map((p) => ({
		name: p.name,
		port: p.port,
		url: p.url,
	}));
}

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
