import { getSandbox } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';

export async function listSandboxFiles(
	env: Env,
	conversationId: string | null,
	path: string,
): Promise<{ path: string; type: 'file' | 'directory' }[]> {
	if (!env.SANDBOX || !conversationId) return [];
	try {
		const sandbox = getSandbox(env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, conversationId);
		const result = await sandbox.exec(`find ${path} -mindepth 1 -maxdepth 3 -printf '%y %p\\n' | sort`);
		if (!result.success) return [];
		return result.stdout
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const typeChar = line[0];
				const filePath = line.slice(2);
				return {
					path: filePath,
					type: typeChar === 'd' ? 'directory' : ('file' as 'file' | 'directory'),
				};
			});
	} catch {
		return [];
	}
}

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
