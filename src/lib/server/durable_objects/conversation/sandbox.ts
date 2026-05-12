import { getSandboxInstance } from '$lib/server/sandbox';
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
		port: p.port,
		url: p.url,
		name: p.name,
	}));
}

export async function getSandboxPreviewPorts(
	env: Env,
	conversationId: string | null,
	hostname: string,
): Promise<ExposedPort[]> {
	if (!conversationId) return [];
	try {
		const instance = await getSandboxInstance(env, conversationId);
		if (!instance) return [];
		return await instance.getExposedPorts(hostname);
	} catch {
		return [];
	}
}

export async function destroySandbox(env: Env, conversationId: string | null): Promise<void> {
	if (!conversationId) return;
	try {
		const instance = await getSandboxInstance(env, conversationId);
		if (!instance) return;
		await instance.destroy();
	} catch {
		/* ignore */
	}
}
