import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';

// Exported for unit testing — lets tests inject a fake sandbox without
// needing the Cloudflare SDK at all.
export async function _listExposedPorts(
	sandbox: { getExposedPorts: (hostname: string) => Promise<unknown> },
	hostname: string,
): Promise<{ port: number; url: string; name?: string }[]> {
	// The @cloudflare/sandbox SDK return shape drifts across versions;
	// defensively normalise both array and object shapes.
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
): Promise<{ port: number; url: string; name?: string }[]> {
	if (!env.SANDBOX || !conversationId) return [];
	try {
		const sandbox = getSandbox(env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, conversationId, { sleepAfter: '1h' });
		return await _listExposedPorts(sandbox as unknown as { getExposedPorts: (hostname: string) => Promise<unknown> }, hostname);
	} catch {
		return [];
	}
}

export async function destroySandbox(env: Env, conversationId: string | null): Promise<void> {
	if (!env.SANDBOX || !conversationId) return;
	try {
		const sandbox = getSandbox(env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, conversationId, { sleepAfter: '1h' });
		await sandbox.destroy();
	} catch {
		/* ignore */
	}
}
