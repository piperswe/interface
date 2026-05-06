import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { ensureWorkspaceMount, sandboxExecTool } from './sandbox';
import type { ToolContext } from './registry';

// Regression: the previous implementation cached "we already mounted this
// conversation" in a Worker-level Set and used the SDK's `localBucket: true`
// mode. Two compounding bugs:
//
//  1. The Worker-level cache survived Sandbox DO eviction, so subsequent
//     tool calls on a fresh DO instance skipped `mountBucket()` entirely
//     and never set up sync.
//
//  2. Even when the mount was established, `localBucket` mode runs its
//     bidirectional sync as `setTimeout` poll loops + an SSE iterator
//     inside the Sandbox DO. Cloudflare evicts the DO from memory shortly
//     after the originating RPC returns, killing the loops before any
//     container→R2 upload can happen. R2 stayed empty in production.
//
// The fix: drop the Worker-level cache (always call `mountBucket`), and
// when R2 S3-API credentials are configured, mount via FUSE so s3fs runs
// inside the container and writes go straight to R2 with no DO-side
// background work to die.

type MockSandbox = {
	mountBucket: ReturnType<typeof vi.fn>;
};

function makeStubNamespace(mock: MockSandbox): unknown {
	const id = { toString: () => 'stub-id' };
	return {
		idFromName: () => id,
		idFromString: () => id,
		newUniqueId: () => id,
		get: () => mock,
		jurisdiction: () => makeStubNamespace(mock),
	};
}

function makeCtx(
	mock: MockSandbox,
	overrides: Partial<{
		WORKSPACE_BUCKET: unknown;
		R2_ENDPOINT: string;
		R2_ACCOUNT_ID: string;
		R2_ACCESS_KEY_ID: string;
		R2_SECRET_ACCESS_KEY: string;
		R2_WORKSPACE_BUCKET_NAME: string;
	}> = {},
): ToolContext {
	const baseEnv = {
		...env,
		SANDBOX: makeStubNamespace(mock) as unknown as DurableObjectNamespace,
		WORKSPACE_BUCKET:
			'WORKSPACE_BUCKET' in overrides ? overrides.WORKSPACE_BUCKET : env.WORKSPACE_BUCKET,
	} as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(overrides)) {
		if (k === 'WORKSPACE_BUCKET') continue;
		baseEnv[k] = v;
	}
	return {
		env: baseEnv as unknown as Env,
		conversationId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
		assistantMessageId: 'm',
	};
}

describe('ensureWorkspaceMount', () => {
	it('is a no-op when WORKSPACE_BUCKET is not bound', async () => {
		const mountBucket = vi.fn();
		await ensureWorkspaceMount(makeCtx({ mountBucket }, { WORKSPACE_BUCKET: undefined }));
		expect(mountBucket).not.toHaveBeenCalled();
	});

	it('calls mountBucket every invocation (no Worker-level cache)', async () => {
		// Simulates a DO eviction race: the same Worker isolate makes three
		// tool calls that hit three fresh DO instances. mountBucket must be
		// called every time so each new DO actually has a mount.
		const mountBucket = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ mountBucket });
		await ensureWorkspaceMount(ctx);
		await ensureWorkspaceMount(ctx);
		await ensureWorkspaceMount(ctx);
		expect(mountBucket).toHaveBeenCalledTimes(3);
	});

	it('uses FUSE mode when R2 credentials are configured', async () => {
		const mountBucket = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx(
			{ mountBucket },
			{
				R2_ACCOUNT_ID: 'abc123',
				R2_ACCESS_KEY_ID: 'AKIA-TEST',
				R2_SECRET_ACCESS_KEY: 'secret-test',
			},
		);
		await ensureWorkspaceMount(ctx);
		expect(mountBucket).toHaveBeenCalledWith('interface-workspace', '/workspace', {
			endpoint: 'https://abc123.r2.cloudflarestorage.com',
			provider: 'r2',
			credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret-test' },
			prefix: `/conversations/${ctx.conversationId}`,
		});
	});

	it('honours R2_ENDPOINT over R2_ACCOUNT_ID for custom endpoints', async () => {
		const mountBucket = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx(
			{ mountBucket },
			{
				R2_ENDPOINT: 'https://custom.example.com',
				R2_ACCOUNT_ID: 'abc123',
				R2_ACCESS_KEY_ID: 'AKIA-TEST',
				R2_SECRET_ACCESS_KEY: 'secret-test',
			},
		);
		await ensureWorkspaceMount(ctx);
		const call = mountBucket.mock.calls[0];
		expect(call[2].endpoint).toBe('https://custom.example.com');
	});

	it('honours R2_WORKSPACE_BUCKET_NAME override', async () => {
		const mountBucket = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx(
			{ mountBucket },
			{
				R2_ACCOUNT_ID: 'abc123',
				R2_ACCESS_KEY_ID: 'AKIA-TEST',
				R2_SECRET_ACCESS_KEY: 'secret-test',
				R2_WORKSPACE_BUCKET_NAME: 'my-renamed-bucket',
			},
		);
		await ensureWorkspaceMount(ctx);
		expect(mountBucket.mock.calls[0][0]).toBe('my-renamed-bucket');
	});

	it('falls back to localBucket mode when R2 credentials are missing', async () => {
		// `localBucket` only really works under `wrangler dev`, but it's
		// what we want as the fallback when secrets aren't configured.
		const mountBucket = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ mountBucket });
		await ensureWorkspaceMount(ctx);
		expect(mountBucket).toHaveBeenCalledWith('WORKSPACE_BUCKET', '/workspace', {
			localBucket: true,
			prefix: `/conversations/${ctx.conversationId}`,
		});
	});

	it('falls back to localBucket when only some credentials are set', async () => {
		const mountBucket = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx(
			{ mountBucket },
			{ R2_ACCESS_KEY_ID: 'AKIA-TEST' /* no secret, no endpoint */ },
		);
		await ensureWorkspaceMount(ctx);
		expect(mountBucket.mock.calls[0][2]).toEqual(
			expect.objectContaining({ localBucket: true }),
		);
	});

	it('tolerates "Mount path already in use" errors from a hot DO', async () => {
		const mountBucket = vi
			.fn()
			.mockRejectedValueOnce(new Error('Mount path already in use: /workspace'))
			.mockRejectedValueOnce(new Error('already mounted at /workspace'))
			.mockResolvedValueOnce(undefined);
		const ctx = makeCtx({ mountBucket });
		await expect(ensureWorkspaceMount(ctx)).resolves.toBeUndefined();
		await expect(ensureWorkspaceMount(ctx)).resolves.toBeUndefined();
		await expect(ensureWorkspaceMount(ctx)).resolves.toBeUndefined();
	});

	it('surfaces unrelated mount errors', async () => {
		const mountBucket = vi
			.fn()
			.mockRejectedValueOnce(new Error('R2 binding "WORKSPACE_BUCKET" not found'));
		const ctx = makeCtx({ mountBucket });
		await expect(ensureWorkspaceMount(ctx)).rejects.toThrow(/not found/);
	});
});

describe('sandbox_exec — default cwd', () => {
	it('description tells the model that /workspace is the persistent default', () => {
		const desc = sandboxExecTool.definition.description ?? '';
		expect(desc).toMatch(/\/workspace/);
		expect(desc).toMatch(/persist/i);
	});
});
