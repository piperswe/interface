import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWorkspaceReady, flushWorkspaceToR2, sandboxExecTool, sandboxReadFileTool, sandboxWriteFileTool } from './sandbox';
import type { ToolContext } from './registry';

// Regression: an earlier implementation mounted /workspace via s3fs-FUSE.
// Every file syscall paid an S3 round-trip, so `git status`, `npm install`,
// and any compiler became unusable. The fix replaces s3fs with rclone and
// supports two user-selectable strategies via the `workspace_io_mode`
// setting:
//
//   - 'snapshot' (default): hydrate /workspace from R2 with `rclone copy` on
//     first use, sync deltas back every 15s plus on every modify-tool RPC.
//     /workspace is a native ext4 directory so reads/writes never pay any
//     FUSE overhead.
//
//   - 'rclone-mount': FUSE mount via `rclone mount --vfs-cache-mode=full`.
//     Local cache absorbs reads after first fetch; writes are pushed back
//     within ~1s of being closed.
//
// The dev fallback (no R2 S3-API credentials configured) still uses the
// SDK's `mountBucket` with `localBucket: true` since the wrangler dev DO is
// long-lived enough for the SDK's setTimeout sync loops to actually run.

type MockSandbox = {
	mountBucket: ReturnType<typeof vi.fn>;
	exec: ReturnType<typeof vi.fn>;
	execStream?: ReturnType<typeof vi.fn>;
	runCode?: ReturnType<typeof vi.fn>;
	readFile: ReturnType<typeof vi.fn>;
	writeFile: ReturnType<typeof vi.fn>;
	deleteFile?: ReturnType<typeof vi.fn>;
	mkdir?: ReturnType<typeof vi.fn>;
	exists?: ReturnType<typeof vi.fn>;
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

function makeMockSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
	return {
		mountBucket: vi.fn().mockResolvedValue(undefined),
		exec: vi.fn().mockResolvedValue({ exitCode: 0, success: true, stdout: '', stderr: '' }),
		execStream: vi.fn(),
		runCode: vi.fn(),
		readFile: vi.fn().mockRejectedValue(new Error('not found')),
		writeFile: vi.fn().mockResolvedValue(undefined),
		deleteFile: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue({ exists: true }),
		...overrides,
	};
}

const CONV_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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
		WORKSPACE_BUCKET: 'WORKSPACE_BUCKET' in overrides ? overrides.WORKSPACE_BUCKET : env.WORKSPACE_BUCKET,
	} as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(overrides)) {
		if (k === 'WORKSPACE_BUCKET') continue;
		baseEnv[k] = v;
	}
	return {
		env: baseEnv as unknown as Env,
		conversationId: CONV_ID,
		assistantMessageId: 'm',
		modelId: 'fake/model',
	};
}

const PROD_R2_OVERRIDES = {
	R2_ACCOUNT_ID: 'abc123',
	R2_ACCESS_KEY_ID: 'AKIA-TEST',
	R2_SECRET_ACCESS_KEY: 'secret-test',
};

async function setIoModeSetting(value: 'snapshot' | 'rclone-mount' | null): Promise<void> {
	if (value === null) {
		await env.DB.prepare('DELETE FROM settings WHERE user_id = 1 AND key = ?').bind('workspace_io_mode').run();
	} else {
		await env.DB.prepare(
			`INSERT INTO settings (user_id, key, value, updated_at) VALUES (1, ?, ?, ?)
			 ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
			.bind('workspace_io_mode', value, Date.now())
			.run();
	}
}

beforeEach(async () => {
	await setIoModeSetting(null);
});

afterEach(async () => {
	await setIoModeSetting(null);
});

describe('ensureWorkspaceReady', () => {
	it('is a no-op when WORKSPACE_BUCKET is not bound', async () => {
		const sandbox = makeMockSandbox();
		await ensureWorkspaceReady(makeCtx(sandbox, { WORKSPACE_BUCKET: undefined }));
		expect(sandbox.mountBucket).not.toHaveBeenCalled();
		expect(sandbox.exec).not.toHaveBeenCalled();
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});

	it('falls back to localBucket mode when R2 credentials are missing (dev only)', async () => {
		// `localBucket` works under `wrangler dev` where the DO is long-lived;
		// production needs the rclone path below.
		const sandbox = makeMockSandbox();
		await ensureWorkspaceReady(makeCtx(sandbox));
		expect(sandbox.mountBucket).toHaveBeenCalledWith('WORKSPACE_BUCKET', '/workspace', {
			localBucket: true,
			prefix: `/conversations/${CONV_ID}`,
		});
		// rclone path should not be touched
		expect(sandbox.exec).not.toHaveBeenCalled();
	});

	it('snapshot mode: writes rclone config, hydrates from R2, starts daemon, marks mode', async () => {
		const sandbox = makeMockSandbox();
		await ensureWorkspaceReady(makeCtx(sandbox, PROD_R2_OVERRIDES));

		// rclone config written with R2 credentials.
		const configCall = sandbox.writeFile.mock.calls.find((c) => c[0] === '/root/.config/rclone/rclone.conf');
		expect(configCall).toBeDefined();
		expect(configCall![1]).toContain('access_key_id = AKIA-TEST');
		expect(configCall![1]).toContain('secret_access_key = secret-test');
		expect(configCall![1]).toContain('endpoint = https://abc123.r2.cloudflarestorage.com');

		// `rclone copy` for hydration and a backgrounded sync daemon.
		const execCommands = sandbox.exec.mock.calls.map((c) => c[0] as string);
		expect(execCommands.some((c) => c.includes('rclone copy') && c.includes('/workspace'))).toBe(true);
		expect(execCommands.some((c) => c.includes('rclone sync') && c.includes('sleep 15'))).toBe(true);

		// Mode marker recorded so a subsequent call short-circuits.
		const markerCall = sandbox.writeFile.mock.calls.find((c) => c[0] === '/var/lib/sandbox/workspace-mode');
		expect(markerCall?.[1]).toBe('snapshot');
	});

	it('rclone-mount mode: invokes `rclone mount` with VFS cache settings, marks mode', async () => {
		await setIoModeSetting('rclone-mount');
		const sandbox = makeMockSandbox();
		await ensureWorkspaceReady(makeCtx(sandbox, PROD_R2_OVERRIDES));

		const execCommands = sandbox.exec.mock.calls.map((c) => c[0] as string);
		expect(execCommands.some((c) => c.includes('rclone mount') && c.includes('--vfs-cache-mode full'))).toBe(true);
		// Should NOT run a hydrate-and-daemon cycle
		expect(execCommands.some((c) => c.includes('rclone copy'))).toBe(false);

		const markerCall = sandbox.writeFile.mock.calls.find((c) => c[0] === '/var/lib/sandbox/workspace-mode');
		expect(markerCall?.[1]).toBe('rclone-mount');
	});

	it('short-circuits when the recorded mode matches the desired mode', async () => {
		const sandbox = makeMockSandbox({
			// readFile returns the marker => "we're already in snapshot mode".
			readFile: vi.fn().mockResolvedValue({ content: 'snapshot', encoding: 'utf-8' }),
		});
		await ensureWorkspaceReady(makeCtx(sandbox, PROD_R2_OVERRIDES));
		// Marker matches desired => no setup work, no marker rewrite.
		expect(sandbox.exec).not.toHaveBeenCalled();
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});

	it('mode change tears down the previous mode before initialising the new one', async () => {
		await setIoModeSetting('rclone-mount');
		// Container reports it's currently in snapshot mode.
		const sandbox = makeMockSandbox({
			readFile: vi.fn().mockResolvedValue({ content: 'snapshot', encoding: 'utf-8' }),
		});
		await ensureWorkspaceReady(makeCtx(sandbox, PROD_R2_OVERRIDES));
		const execCommands = sandbox.exec.mock.calls.map((c) => c[0] as string);
		// Final flush + daemon kill happens before mounting.
		const teardownIdx = execCommands.findIndex((c) => c.includes('sandbox-rclone-sync.pid'));
		const mountIdx = execCommands.findIndex((c) => c.includes('rclone mount'));
		expect(teardownIdx).toBeGreaterThanOrEqual(0);
		expect(mountIdx).toBeGreaterThan(teardownIdx);
	});
});

describe('flushWorkspaceToR2', () => {
	it('is a no-op when bucket or credentials are missing', async () => {
		const sandbox = makeMockSandbox();
		await flushWorkspaceToR2(makeCtx(sandbox, { WORKSPACE_BUCKET: undefined }));
		expect(sandbox.exec).not.toHaveBeenCalled();
		await flushWorkspaceToR2(makeCtx(sandbox)); // missing R2 creds
		expect(sandbox.exec).not.toHaveBeenCalled();
	});

	it('runs `rclone sync` in snapshot mode', async () => {
		const sandbox = makeMockSandbox({
			readFile: vi.fn().mockResolvedValue({ content: 'snapshot', encoding: 'utf-8' }),
		});
		await flushWorkspaceToR2(makeCtx(sandbox, PROD_R2_OVERRIDES));
		const cmd = sandbox.exec.mock.calls[0]?.[0] as string;
		expect(cmd).toMatch(/rclone sync\b/);
		expect(cmd).toContain('/workspace');
	});

	it('runs `sync` in rclone-mount mode', async () => {
		const sandbox = makeMockSandbox({
			readFile: vi.fn().mockResolvedValue({ content: 'rclone-mount', encoding: 'utf-8' }),
		});
		await flushWorkspaceToR2(makeCtx(sandbox, PROD_R2_OVERRIDES));
		const cmd = sandbox.exec.mock.calls[0]?.[0] as string;
		expect(cmd).toContain('sync');
		expect(cmd).not.toContain('rclone sync');
	});

	it('swallows flush errors so a failed sync does not break the tool RPC', async () => {
		const sandbox = makeMockSandbox({
			readFile: vi.fn().mockResolvedValue({ content: 'snapshot', encoding: 'utf-8' }),
			exec: vi.fn().mockResolvedValue({ exitCode: 1, success: false, stdout: '', stderr: 'boom' }),
		});
		await expect(flushWorkspaceToR2(makeCtx(sandbox, PROD_R2_OVERRIDES))).resolves.toBeUndefined();
	});
});

describe('tool wiring (modify vs read-only)', () => {
	it('sandbox_write_file flushes to R2 after writing', async () => {
		const sandbox = makeMockSandbox({
			// Already in snapshot mode so ensureWorkspaceReady is a no-op.
			readFile: vi.fn().mockResolvedValue({ content: 'snapshot', encoding: 'utf-8' }),
		});
		const ctx = makeCtx(sandbox, PROD_R2_OVERRIDES);
		const result = await sandboxWriteFileTool.execute(ctx, { path: '/workspace/x.txt', content: 'hi' });
		expect(result.isError).not.toBe(true);
		expect(sandbox.writeFile).toHaveBeenCalledWith('/workspace/x.txt', 'hi');
		// flushWorkspaceToR2 should have been invoked => exec ran rclone sync.
		const execCommands = sandbox.exec.mock.calls.map((c) => c[0] as string);
		expect(execCommands.some((c) => c.includes('rclone sync'))).toBe(true);
	});

	it('sandbox_read_file does NOT flush to R2', async () => {
		const sandbox = makeMockSandbox({
			readFile: vi.fn().mockImplementation(async (p: string) => {
				if (p === '/var/lib/sandbox/workspace-mode') return { content: 'snapshot', encoding: 'utf-8' };
				return { content: 'hello', encoding: 'utf-8' };
			}),
		});
		const ctx = makeCtx(sandbox, PROD_R2_OVERRIDES);
		await sandboxReadFileTool.execute(ctx, { path: '/workspace/x.txt' });
		const execCommands = sandbox.exec.mock.calls.map((c) => c[0] as string);
		expect(execCommands.some((c) => c.includes('rclone sync'))).toBe(false);
	});
});

describe('sandbox_exec — default cwd', () => {
	it('description tells the model that /workspace is the persistent default', () => {
		const desc = sandboxExecTool.definition.description ?? '';
		expect(desc).toMatch(/\/workspace/);
		expect(desc).toMatch(/persist/i);
	});
});
