import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';

export async function getSandboxPreviewPorts(
	env: Env,
	conversationId: string | null,
): Promise<{ port: number; url: string; name?: string }[]> {
	if (!env.SANDBOX || !conversationId) return [];
	try {
		const sandbox = getSandbox(env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, conversationId);
		// The @cloudflare/sandbox SDK return shape drifts across versions;
		// defensively normalise both array and object shapes.
		const result = await (sandbox as unknown as { getExposedPorts: () => Promise<unknown> }).getExposedPorts();
		const ports = Array.isArray(result) ? result : ((result as { ports?: unknown[] }).ports ?? []);
		return (ports as Array<{ port: number; url: string; name?: string }>).map((p) => ({
			port: p.port,
			url: p.url,
			name: p.name,
		}));
	} catch {
		return [];
	}
}

export async function destroySandbox(env: Env, conversationId: string | null): Promise<void> {
	if (!env.SANDBOX || !conversationId) return;
	try {
		const sandbox = getSandbox(env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, conversationId);
		await sandbox.destroy();
	} catch {
		/* ignore */
	}
}
