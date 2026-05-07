import { getSandbox, parseSSEStream } from '@cloudflare/sandbox';
import type { Sandbox, ExecEvent, ExecResult } from '@cloudflare/sandbox';
import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import { getWorkspaceIoMode, type WorkspaceIoMode } from '$lib/server/settings';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';
import type { ProviderModel } from '../providers/types';
import { parseGlobalModelId } from '../providers/types';

// Zod schemas for validating LLM-supplied tool arguments. Each tool's
// `definition.inputSchema` is the JSON schema the LLM sees; these run on
// the parsed JSON it produces.
const execArgsSchema = z.object({
	command: z.string(),
	cwd: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	stdin: z.string().optional(),
	timeout: z.number().optional(),
});
const runCodeArgsSchema = z.object({
	code: z.string(),
	language: z.enum(['python', 'javascript', 'typescript']).optional(),
	timeout: z.number().optional(),
});
const pathOnlyArgsSchema = z.object({ path: z.string() });
const writeFileArgsSchema = z.object({ path: z.string(), content: z.string() });
const mkdirArgsSchema = z.object({ path: z.string(), recursive: z.boolean().optional() });
const createArtifactArgsSchema = z.object({
	path: z.string(),
	type: z.enum(['code', 'markdown', 'html', 'svg', 'mermaid']).optional(),
	name: z.string().optional(),
	language: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helper: resolve a sandbox instance scoped to the current conversation.
// ---------------------------------------------------------------------------
function getConversationSandbox(ctx: ToolContext) {
	if (!ctx.env.SANDBOX) {
		throw new Error('Sandbox binding is not configured.');
	}
	return getSandbox(ctx.env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, ctx.conversationId, { sleepAfter: '1h' });
}

// ---------------------------------------------------------------------------
// SSH key injection (one-time per conversation, keyed on key fingerprint)
// ---------------------------------------------------------------------------
// Keyed by `${conversationId}:${keyFingerprint}` so rotating
// `SANDBOX_SSH_KEY` causes a re-injection on the next call (instead of
// every conversation that already saw the old key being stuck with it
// until the isolate cycles).
const sshKeyInjected = new Set<string>();

const SSH_KEY_PATH = '/root/.ssh/sandbox_key';
const SSH_CONFIG_PATH = '/root/.ssh/config';

const SSH_CONFIG = `Host github.com
	HostName github.com
	User git
	IdentityFile ${SSH_KEY_PATH}
	IdentitiesOnly yes
	StrictHostKeyChecking accept-new
`;

// Stable, low-collision fingerprint of the key bytes. Not cryptographic —
// just used to detect rotation. Hash via Web Crypto (SHA-256, first 16 hex
// chars). Cached so we don't re-hash every call.
const fingerprintCache = new Map<string, string>();
async function fingerprintKey(key: string): Promise<string> {
	const cached = fingerprintCache.get(key);
	if (cached) return cached;
	const bytes = new TextEncoder().encode(key);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hex = Array.from(new Uint8Array(digest))
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	fingerprintCache.set(key, hex);
	return hex;
}

async function injectSshKey(sandbox: ReturnType<typeof getSandbox>, key: string): Promise<void> {
	try {
		await sandbox.mkdir('/root/.ssh', { recursive: true });
	} catch {
		/* may already exist */
	}
	await sandbox.exec('chmod 700 /root/.ssh');
	const normalizedKey = key.endsWith('\n') ? key : key + '\n';
	await sandbox.writeFile(SSH_KEY_PATH, normalizedKey);
	await sandbox.exec(`chmod 600 ${SSH_KEY_PATH}`);
	await sandbox.writeFile(SSH_CONFIG_PATH, SSH_CONFIG);
	await sandbox.exec(`chmod 600 ${SSH_CONFIG_PATH}`);
}

async function ensureSshKey(ctx: ToolContext): Promise<void> {
	const key = ctx.env.SANDBOX_SSH_KEY;
	if (!key) return;
	const fp = await fingerprintKey(key);
	const cacheKey = `${ctx.conversationId}:${fp}`;
	if (sshKeyInjected.has(cacheKey)) return;
	const sandbox = getConversationSandbox(ctx);
	await injectSshKey(sandbox, key);
	sshKeyInjected.add(cacheKey);
}

// ---------------------------------------------------------------------------
// R2-backed /workspace
// ---------------------------------------------------------------------------
// Each conversation gets its own R2 prefix (`conversations/{id}/`) so files
// are isolated across conversations. We support two strategies, chosen by the
// `workspace_io_mode` user setting:
//
// - 'snapshot' (default, fastest): /workspace is a native ext4 directory
//   inside the container. On first use we hydrate it from R2 with
//   `rclone copy`. A background daemon inside the container syncs deltas back
//   every 15s, and every modify-tool RPC also runs `rclone sync` synchronously
//   before returning — so files become durable on every tool boundary, with a
//   bounded ~15s window of risk during long-running tool calls.
//
// - 'rclone-mount': /workspace is a FUSE mount via `rclone mount` with a 4 GB
//   local VFS cache (`--vfs-cache-mode=full`). Reads always go through the
//   live mount; writes are buffered locally and pushed to R2 by rclone's
//   write-back loop (~1s lag). Modify-tool RPCs flush dirty pages with
//   `sync && sleep 2` so subsequent file-browser reads see fresh data.
//
// Why we no longer use the SDK's `mountBucket()` (s3fs):
//
//   s3fs translates every POSIX syscall to an S3 API call. `git status` over
//   a working tree, `npm install`, and compilation became unusable because
//   each `stat`/`open`/`read` paid a network round-trip. The container's
//   native FS is fast — the FUSE-to-R2 indirection was the bottleneck.
//
// Dev fallback: when R2 S3-API credentials aren't configured (typical for
// `wrangler dev`), we fall back to the SDK's `mountBucket('WORKSPACE_BUCKET',
// { localBucket: true })`. localBucket runs setTimeout/SSE sync loops inside
// the Sandbox DO; that's broken in production (DO eviction kills the loops
// before they upload) but works under the long-lived `wrangler dev` DO.

// Default matches `r2_buckets[0].bucket_name` in wrangler.jsonc. Override
// via the `R2_WORKSPACE_BUCKET_NAME` secret if you renamed the bucket.
const DEFAULT_R2_BUCKET_NAME = 'interface-workspace';

const RCLONE_CONFIG_PATH = '/root/.config/rclone/rclone.conf';
const RCLONE_REMOTE = 'r2';
const WORKSPACE_PATH = '/workspace';
const MODE_MARKER_PATH = '/var/lib/sandbox/workspace-mode';
const SYNC_DAEMON_PID_PATH = '/var/run/sandbox-rclone-sync.pid';
const SNAPSHOT_SYNC_INTERVAL_SECONDS = 15;
// rclone's remote-control HTTP API for the FUSE mount. Used by the
// mount-mode flush path (currently we just `sync && sleep` but the address is
// reserved for future `rclone rc` calls if we need finer-grained flush).
const RCLONE_RC_ADDR = '127.0.0.1:5572';

function r2Endpoint(env: Env): string | undefined {
	if (env.R2_ENDPOINT) return env.R2_ENDPOINT;
	if (env.R2_ACCOUNT_ID) return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
	return undefined;
}

type R2Config = {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucketName: string;
	prefix: string;
};

function r2ConfigFromEnv(ctx: ToolContext): R2Config | null {
	const endpoint = r2Endpoint(ctx.env);
	const accessKeyId = ctx.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = ctx.env.R2_SECRET_ACCESS_KEY;
	if (!endpoint || !accessKeyId || !secretAccessKey) return null;
	return {
		endpoint,
		accessKeyId,
		secretAccessKey,
		bucketName: ctx.env.R2_WORKSPACE_BUCKET_NAME ?? DEFAULT_R2_BUCKET_NAME,
		prefix: `conversations/${ctx.conversationId}`,
	};
}

function rcloneConfigFile(cfg: R2Config): string {
	// Anchor secrets to keys; rclone reads the [r2] section by name only, so
	// the values can contain arbitrary characters as long as they're on a
	// single line (rclone strips trailing whitespace). R2 access/secret keys
	// are hex/base64 with no embedded newlines, which is safe.
	return [
		`[${RCLONE_REMOTE}]`,
		'type = s3',
		'provider = Other',
		`endpoint = ${cfg.endpoint}`,
		`access_key_id = ${cfg.accessKeyId}`,
		`secret_access_key = ${cfg.secretAccessKey}`,
		'acl = private',
		'no_check_bucket = true',
		'',
	].join('\n');
}

function r2Remote(cfg: R2Config): string {
	return `${RCLONE_REMOTE}:${cfg.bucketName}/${cfg.prefix}`;
}

function isMountAlreadyError(e: unknown): boolean {
	return e instanceof Error && /(already (mount|in use))|not empty/i.test(e.message);
}

async function callMountBucketTolerant(
	sandbox: ReturnType<typeof getSandbox>,
	bindingOrName: string,
	target: string,
	options: Parameters<ReturnType<typeof getSandbox>['mountBucket']>[2],
): Promise<void> {
	try {
		await sandbox.mountBucket(bindingOrName, target, options);
	} catch (e) {
		if (!isMountAlreadyError(e)) throw e;
	}
}

// Reads the current workspace mode marker from inside the container. The
// marker lives on the container's local FS so it's automatically cleared on
// container restart (forcing a fresh init) but persists across Worker isolate
// cycles within one container.
async function readWorkspaceMode(sandbox: ReturnType<typeof getSandbox>): Promise<WorkspaceIoMode | null> {
	try {
		const file = await sandbox.readFile(MODE_MARKER_PATH);
		const v = file.content.trim();
		if (v === 'snapshot' || v === 'rclone-mount') return v;
		return null;
	} catch {
		return null;
	}
}

async function writeWorkspaceMode(sandbox: ReturnType<typeof getSandbox>, mode: WorkspaceIoMode): Promise<void> {
	await sandbox.writeFile(MODE_MARKER_PATH, mode);
}

async function writeRcloneConfig(sandbox: ReturnType<typeof getSandbox>, cfg: R2Config): Promise<void> {
	await sandbox.writeFile(RCLONE_CONFIG_PATH, rcloneConfigFile(cfg));
	await sandbox.exec(`chmod 600 ${RCLONE_CONFIG_PATH}`);
}

async function execOrThrow(sandbox: ReturnType<typeof getSandbox>, command: string): Promise<void> {
	const result = await sandbox.exec(command);
	if (!result.success) {
		throw new Error(`Sandbox command failed (exit ${result.exitCode}): ${command}\nstderr: ${result.stderr}`);
	}
}

async function initSnapshotMode(sandbox: ReturnType<typeof getSandbox>, cfg: R2Config): Promise<void> {
	const remote = r2Remote(cfg);
	// Hydrate /workspace from R2, then start the periodic background sync
	// daemon. setsid + nohup detaches the daemon so it survives the parent
	// shell exiting at exec-RPC return; the daemon dies with the container.
	await execOrThrow(
		sandbox,
		`set -e; mkdir -p ${WORKSPACE_PATH}; rclone copy ${JSON.stringify(remote)}/ ${WORKSPACE_PATH} --transfers 32 --checkers 32 --fast-list 2>&1 | tail -50 || true`,
	);
	const daemonScript = `while true; do rclone sync ${WORKSPACE_PATH} ${JSON.stringify(remote)}/ --transfers 32 --checkers 32 --fast-list >> /var/log/rclone-sync.log 2>&1; sleep ${SNAPSHOT_SYNC_INTERVAL_SECONDS}; done`;
	await execOrThrow(
		sandbox,
		`set -e; nohup setsid bash -c ${JSON.stringify(daemonScript)} </dev/null >/dev/null 2>&1 & echo $! > ${SYNC_DAEMON_PID_PATH}; disown; true`,
	);
}

async function teardownSnapshotMode(sandbox: ReturnType<typeof getSandbox>, cfg: R2Config): Promise<void> {
	const remote = r2Remote(cfg);
	// Final flush, kill the daemon, then empty /workspace so the next mode can
	// repopulate cleanly.
	await execOrThrow(
		sandbox,
		`set -e; rclone sync ${WORKSPACE_PATH} ${JSON.stringify(remote)}/ --transfers 32 --checkers 32 --fast-list 2>&1 | tail -20 || true; PID=$(cat ${SYNC_DAEMON_PID_PATH} 2>/dev/null || true); if [ -n "$PID" ]; then kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true; fi; rm -f ${SYNC_DAEMON_PID_PATH}; find ${WORKSPACE_PATH} -mindepth 1 -delete 2>/dev/null || true`,
	);
}

async function initRcloneMountMode(sandbox: ReturnType<typeof getSandbox>, cfg: R2Config): Promise<void> {
	const remote = r2Remote(cfg);
	// Best-effort cleanup of any leftover mount, then mount fresh. --daemon
	// returns once the mount is ready; --vfs-write-back 1s bounds the lag
	// between local writes and R2 uploads.
	await execOrThrow(
		sandbox,
		`set -e; mkdir -p ${WORKSPACE_PATH} /var/cache/rclone-vfs; fusermount -u ${WORKSPACE_PATH} 2>/dev/null || true; rclone mount ${JSON.stringify(remote)}/ ${WORKSPACE_PATH} --vfs-cache-mode full --vfs-cache-max-size 4G --vfs-cache-max-age 24h --vfs-write-back 1s --transfers 32 --dir-cache-time 5s --rc --rc-no-auth --rc-addr ${RCLONE_RC_ADDR} --cache-dir /var/cache/rclone-vfs --daemon`,
	);
}

async function teardownRcloneMountMode(sandbox: ReturnType<typeof getSandbox>): Promise<void> {
	await execOrThrow(
		sandbox,
		`set -e; fusermount -u ${WORKSPACE_PATH} 2>/dev/null || umount -l ${WORKSPACE_PATH} 2>/dev/null || true; find ${WORKSPACE_PATH} -mindepth 1 -delete 2>/dev/null || true`,
	);
}

export async function ensureWorkspaceReady(ctx: ToolContext): Promise<void> {
	if (!ctx.env.WORKSPACE_BUCKET) return;
	const sandbox = getConversationSandbox(ctx);
	const cfg = r2ConfigFromEnv(ctx);

	if (!cfg) {
		// Dev fallback: SDK-managed localBucket. Cloudflare evicts the DO
		// shortly after the originating RPC returns in production so the sync
		// loops never run, but the wrangler dev DO is long-lived enough for
		// it to work locally.
		await callMountBucketTolerant(sandbox, 'WORKSPACE_BUCKET', WORKSPACE_PATH, {
			localBucket: true,
			prefix: `/conversations/${ctx.conversationId}`,
		});
		return;
	}

	const desiredMode = await getWorkspaceIoMode(ctx.env);
	const currentMode = await readWorkspaceMode(sandbox);
	if (currentMode === desiredMode) return;

	// Mode change (or first init): tear down old, set up new.
	if (currentMode === 'snapshot') {
		await teardownSnapshotMode(sandbox, cfg);
	} else if (currentMode === 'rclone-mount') {
		await teardownRcloneMountMode(sandbox);
	}
	await writeRcloneConfig(sandbox, cfg);
	if (desiredMode === 'snapshot') {
		await initSnapshotMode(sandbox, cfg);
	} else {
		await initRcloneMountMode(sandbox, cfg);
	}
	await writeWorkspaceMode(sandbox, desiredMode);
}

// Synchronously push pending /workspace writes to R2. Runs at the end of every
// modify-tool RPC so file-browser reads (which hit R2 directly via the
// WORKSPACE_BUCKET binding, not the FUSE mount) see fresh data and so the
// session is durable on tool-call boundaries even if the DO is evicted between
// calls. Failures are non-fatal — the snapshot daemon (15s) or rclone's
// write-back (~1s) will eventually catch up.
export async function flushWorkspaceToR2(ctx: ToolContext): Promise<void> {
	if (!ctx.env.WORKSPACE_BUCKET) return;
	const cfg = r2ConfigFromEnv(ctx);
	if (!cfg) return;
	const sandbox = getConversationSandbox(ctx);
	const mode = await readWorkspaceMode(sandbox);
	try {
		if (mode === 'snapshot') {
			await execOrThrow(
				sandbox,
				`rclone sync ${WORKSPACE_PATH} ${JSON.stringify(r2Remote(cfg))}/ --transfers 32 --checkers 32 --fast-list 2>&1 | tail -20`,
			);
		} else if (mode === 'rclone-mount') {
			// Force kernel buffers out and wait one --vfs-write-back cycle
			// (configured to 1s above) to let rclone push the writes to R2.
			await execOrThrow(sandbox, 'sync; sleep 2');
		}
	} catch {
		// Eventual consistency is acceptable here. The background sync loop
		// (snapshot) or VFS write-back (mount) will retry on the next tick.
	}
}

function formatExecResult(result: Pick<ExecResult, 'exitCode' | 'success' | 'stdout' | 'stderr'>): ToolExecutionResult {
	const lines: string[] = [`exitCode: ${result.exitCode}`, `success: ${result.success}`];
	if (result.stdout) {
		lines.push('', '--- stdout ---', result.stdout);
	}
	if (result.stderr) {
		lines.push('', '--- stderr ---', result.stderr);
	}
	return {
		content: lines.join('\n'),
		isError: !result.success,
	};
}

// ---------------------------------------------------------------------------
// sandbox_exec
// ---------------------------------------------------------------------------
const execInputSchema = {
	type: 'object',
	properties: {
		command: { type: 'string', description: 'Shell command to execute.' },
		cwd: { type: 'string', description: 'Optional working directory for the command.' },
		env: {
			type: 'object',
			additionalProperties: { type: 'string' },
			description: 'Optional environment variables as key-value strings.',
		},
		stdin: { type: 'string', description: 'Optional data to pass via stdin.' },
		timeout: {
			type: 'integer',
			minimum: 1000,
			description: 'Optional timeout in milliseconds (default: no timeout).',
		},
	},
	required: ['command'],
} as const;

export const sandboxExecTool: Tool = {
	definition: {
		name: 'sandbox_exec',
		description:
			"Execute a shell command inside the conversation's isolated sandbox. Returns stdout, stderr, exit code, and success status. Use for running scripts, installing packages, compiling code, or any shell-level operation. The sandbox is running the latest Debian testing as root. Use `apt-get` to install packages. Ensure you run `apt-get update` before `apt-get install`. The default working directory is `/workspace`, which is the only directory whose contents persist across sandbox restarts and is visible to the user in the file browser. Files written elsewhere (e.g. `/tmp`, `/root`) are ephemeral and are NOT synced to R2.",
		inputSchema: execInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(execArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		const cwd = args.cwd ?? '/workspace';
		try {
			await ensureWorkspaceReady(ctx);
			await ensureSshKey(ctx);
			const sandbox = getConversationSandbox(ctx);
			if (ctx.emitToolOutput) {
				// NOTE: ctx.signal is intentionally not forwarded into the
				// RPC options. AbortSignal serialization over Durable Object
				// RPC requires the experimental `enable_abortsignal_rpc`
				// compatibility flag; passing it without the flag throws
				// "AbortSignal serialization is not enabled". The signal is
				// still honored when iterating the SSE stream below.
				const stream = await sandbox.execStream(args.command, {
					cwd,
					...(args.env ? { env: args.env } : {}),
					...(args.stdin ? { stdin: args.stdin } : {}),
					...(args.timeout ? { timeout: args.timeout } : {}),
				});

				// Regression: previously this branch did
				//   `for await (const ev of parseSSEStream(stream, ctx.signal))`
				// and broke on `complete`. The for-await's break runs the
				// generator's `finally` which does `await reader.cancel()`.
				// `stream` is an HTTP response body proxied across the
				// Sandbox-DO -> Conversation-DO RPC boundary; cancel
				// propagation across that boundary stalls in some cases, so
				// the awaited cancel() in the generator's finally never
				// resolves and the tool call hung forever (UI stuck in
				// STREAMING). The fix runs the consumer as a floating task
				// and resolves the outer function as soon as we see
				// `complete` (or an error / idle / outer-abort), without
				// awaiting generator teardown. Also covers streams that
				// never emit `complete` via the idle watchdog.
				const callAc = new AbortController();
				const onOuterAbort = () => callAc.abort();
				if (ctx.signal) {
					if (ctx.signal.aborted) callAc.abort();
					else ctx.signal.addEventListener('abort', onOuterAbort, { once: true });
				}

				const IDLE_MS = 60_000;
				let idleTimer: ReturnType<typeof setTimeout> | undefined;
				let idledOut = false;
				const armIdle = () => {
					if (idleTimer) clearTimeout(idleTimer);
					idleTimer = setTimeout(() => {
						idledOut = true;
						callAc.abort();
					}, IDLE_MS);
				};
				armIdle();

				let stdout = '';
				let stderr = '';
				let exitCode: number | undefined;
				let streamError: string | undefined;
				let resolved = false;
				let resolveOuter!: () => void;
				const outerDone = new Promise<void>((r) => {
					resolveOuter = r;
				});
				const finish = () => {
					if (!resolved) {
						resolved = true;
						resolveOuter();
					}
				};

				// Float the consumer. We never await it — parseSSEStream's
				// finally does `await reader.cancel()` on the RPC-piped
				// upstream stream and that can hang. The container's idle
				// timeout will eventually clean up.
				void (async () => {
					try {
						for await (const ev of parseSSEStream<ExecEvent>(stream, callAc.signal)) {
							armIdle();
							if (resolved) continue; // suppress late chunks
							if (ev.type === 'stdout' || ev.type === 'stderr') {
								if (ev.data) {
									if (ev.type === 'stdout') stdout += ev.data;
									else stderr += ev.data;
									ctx.emitToolOutput!(ev.data);
								}
							} else if (ev.type === 'complete') {
								exitCode = ev.exitCode;
								callAc.abort(); // best-effort: nudge upstream cancel
								finish();
								return;
							} else if (ev.type === 'error') {
								streamError = ev.data ?? ev.error ?? 'Exec stream error';
								callAc.abort();
								finish();
								return;
							}
						}
						// Stream closed without a `complete` event.
						finish();
					} catch (e) {
						if (!callAc.signal.aborted && !resolved) {
							streamError = e instanceof Error ? e.message : String(e);
						}
						finish();
					}
				})().catch(() => {
					// Belt-and-suspenders: the inner try/catch already swallows.
				});

				await outerDone;
				if (idleTimer) clearTimeout(idleTimer);
				if (ctx.signal) ctx.signal.removeEventListener('abort', onOuterAbort);

				if (ctx.signal?.aborted) {
					return { content: 'Tool execution aborted', isError: true };
				}
				if (streamError !== undefined) {
					return { content: streamError, isError: true };
				}
				if (exitCode === undefined) {
					const partial = [
						idledOut
							? `Exec stream stalled (no output for ${IDLE_MS / 1000}s)`
							: 'Exec stream ended without completion',
					];
					if (stdout) partial.push('', '--- stdout ---', stdout);
					if (stderr) partial.push('', '--- stderr ---', stderr);
					return { content: partial.join('\n'), isError: true };
				}

				// flushWorkspaceToR2 has no internal timeout and swallows
				// errors; race it so a hung rclone sync can't reproduce the
				// same "tool never returns" symptom. The 15s background
				// daemon catches up if we race out.
				await Promise.race([flushWorkspaceToR2(ctx), new Promise<void>((r) => setTimeout(r, 30_000))]);
				return formatExecResult({ success: exitCode === 0, exitCode, stdout, stderr });
			}
			const result = await sandbox.exec(args.command, {
				cwd,
				...(args.env ? { env: args.env } : {}),
				...(args.stdin ? { stdin: args.stdin } : {}),
				...(args.timeout ? { timeout: args.timeout } : {}),
			});
			await flushWorkspaceToR2(ctx);
			return formatExecResult(result);
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	},
};

// ---------------------------------------------------------------------------
// sandbox_run_code
// ---------------------------------------------------------------------------
const runCodeInputSchema = {
	type: 'object',
	properties: {
		code: { type: 'string', description: 'Code to execute.' },
		language: {
			type: 'string',
			enum: ['python', 'javascript', 'typescript'],
			description: 'Language to run (default: python).',
		},
		timeout: {
			type: 'integer',
			minimum: 1000,
			description: 'Optional timeout in milliseconds (default: 60000).',
		},
	},
	required: ['code'],
} as const;

export const sandboxRunCodeTool: Tool = {
	definition: {
		name: 'sandbox_run_code',
		description:
			"Execute Python, JavaScript, or TypeScript code inside the conversation's isolated sandbox. The default execution context is reused for the same language, so variables and imports persist across calls in this conversation. Returns the last expression result, stdout/stderr logs, and any execution errors. Use for data analysis, calculations, or any interpreted code.",
		inputSchema: runCodeInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(runCodeArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		const language = args.language ?? 'python';
		try {
			await ensureWorkspaceReady(ctx);
			await ensureSshKey(ctx);
			const sandbox = getConversationSandbox(ctx);
			const result = await sandbox.runCode(args.code, {
				language,
				...(args.timeout ? { timeout: args.timeout } : {}),
			});
			await flushWorkspaceToR2(ctx);
			const lines: string[] = [];

			if (result.logs.stdout.length > 0) {
				lines.push('--- stdout ---');
				lines.push(...result.logs.stdout);
			}
			if (result.logs.stderr.length > 0) {
				lines.push('', '--- stderr ---');
				lines.push(...result.logs.stderr);
			}
			if (result.results && result.results.length > 0) {
				lines.push('', '--- results ---');
				for (const r of result.results) {
					if (r.text) lines.push(r.text);
					else if (r.html) lines.push(`[html: ${r.html.slice(0, 500)}...]`);
					else if (r.json) lines.push(JSON.stringify(r.json));
					else if (r.png) lines.push('[png image result]');
					else if (r.jpeg) lines.push('[jpeg image result]');
					else if (r.svg) lines.push(`[svg: ${r.svg.slice(0, 500)}...]`);
					else if (r.markdown) lines.push(r.markdown);
					else lines.push('[unknown result type]');
				}
			}
			if (result.error) {
				lines.push('', '--- error ---');
				lines.push(`Name: ${result.error.name}`);
				lines.push(`Message: ${result.error.message}`);
				if (result.error.traceback) {
					lines.push('Traceback:', ...result.error.traceback);
				}
				return { content: lines.join('\n'), isError: true };
			}
			return { content: lines.join('\n') };
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	},
};

// ---------------------------------------------------------------------------
// sandbox_read_file
// ---------------------------------------------------------------------------
const readFileInputSchema = {
	type: 'object',
	properties: {
		path: { type: 'string', description: 'Absolute path of the file to read.' },
	},
	required: ['path'],
} as const;

export const sandboxReadFileTool: Tool = {
	definition: {
		name: 'sandbox_read_file',
		description: "Read the contents of a file from the conversation's sandbox filesystem.",
		inputSchema: readFileInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(pathOnlyArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		try {
			await ensureWorkspaceReady(ctx);
			const sandbox = getConversationSandbox(ctx);
			const file = await sandbox.readFile(args.path);
			return {
				content: file.content,
				// If the file is base64-encoded, surface that info in the text so the model knows.
				...(file.encoding === 'base64'
					? { artifacts: [{ type: 'code' as const, name: args.path.split('/').pop(), language: 'base64', content: file.content }] }
					: {}),
			};
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	},
};

// ---------------------------------------------------------------------------
// sandbox_write_file
// ---------------------------------------------------------------------------
const writeFileInputSchema = {
	type: 'object',
	properties: {
		path: { type: 'string', description: 'Absolute path of the file to write.' },
		content: { type: 'string', description: 'File contents as a string.' },
	},
	required: ['path', 'content'],
} as const;

export const sandboxWriteFileTool: Tool = {
	definition: {
		name: 'sandbox_write_file',
		description:
			"Write (or overwrite) a file in the conversation's sandbox filesystem. Write under `/workspace/` to persist the file across sandbox restarts and surface it in the user's file browser; files written outside `/workspace` are ephemeral and not synced to R2.",
		inputSchema: writeFileInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(writeFileArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		try {
			await ensureWorkspaceReady(ctx);
			const sandbox = getConversationSandbox(ctx);
			await sandbox.writeFile(args.path, args.content);
			await flushWorkspaceToR2(ctx);
			return { content: `Wrote ${args.path}` };
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	},
};

// ---------------------------------------------------------------------------
// sandbox_delete_file
// ---------------------------------------------------------------------------
const deleteFileInputSchema = {
	type: 'object',
	properties: {
		path: { type: 'string', description: 'Absolute path of the file to delete.' },
	},
	required: ['path'],
} as const;

export const sandboxDeleteFileTool: Tool = {
	definition: {
		name: 'sandbox_delete_file',
		description: "Delete a file from the conversation's sandbox filesystem.",
		inputSchema: deleteFileInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(pathOnlyArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		try {
			await ensureWorkspaceReady(ctx);
			const sandbox = getConversationSandbox(ctx);
			await sandbox.deleteFile(args.path);
			await flushWorkspaceToR2(ctx);
			return { content: `Deleted ${args.path}` };
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	},
};

// ---------------------------------------------------------------------------
// sandbox_mkdir
// ---------------------------------------------------------------------------
const mkdirInputSchema = {
	type: 'object',
	properties: {
		path: { type: 'string', description: 'Absolute path of the directory to create.' },
		recursive: {
			type: 'boolean',
			description: 'Create parent directories as needed (default: false).',
		},
	},
	required: ['path'],
} as const;

export const sandboxMkdirTool: Tool = {
	definition: {
		name: 'sandbox_mkdir',
		description:
			"Create a directory in the conversation's sandbox filesystem. Create under `/workspace/` for persistence; directories outside `/workspace` are ephemeral.",
		inputSchema: mkdirInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(mkdirArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		try {
			await ensureWorkspaceReady(ctx);
			const sandbox = getConversationSandbox(ctx);
			await sandbox.mkdir(args.path, { recursive: !!args.recursive });
			await flushWorkspaceToR2(ctx);
			return { content: `Created directory ${args.path}` };
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	},
};

// ---------------------------------------------------------------------------
// sandbox_exists
// ---------------------------------------------------------------------------
const existsInputSchema = {
	type: 'object',
	properties: {
		path: { type: 'string', description: 'Absolute path to check.' },
	},
	required: ['path'],
} as const;

export const sandboxExistsTool: Tool = {
	definition: {
		name: 'sandbox_exists',
		description: "Check whether a file or directory exists in the conversation's sandbox filesystem.",
		inputSchema: existsInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(pathOnlyArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		try {
			await ensureWorkspaceReady(ctx);
			const sandbox = getConversationSandbox(ctx);
			const result = await sandbox.exists(args.path);
			return { content: result.exists ? 'true' : 'false' };
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	},
};

// ---------------------------------------------------------------------------
// sandbox_create_artifact
// ---------------------------------------------------------------------------
const createArtifactInputSchema = {
	type: 'object',
	properties: {
		path: { type: 'string', description: 'Absolute path of the file to turn into an artifact.' },
		type: {
			type: 'string',
			enum: ['code', 'markdown', 'html', 'svg', 'mermaid'],
			description: 'Artifact type (default: auto-detected from file extension).',
		},
		name: { type: 'string', description: 'Optional display name for the artifact (default: filename).' },
		language: { type: 'string', description: 'Optional language hint for code artifacts (default: auto-detected).' },
	},
	required: ['path'],
} as const;

function inferArtifactType(path: string): 'code' | 'markdown' | 'html' | 'svg' | 'mermaid' {
	const lower = path.toLowerCase();
	if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
	if (lower.endsWith('.svg')) return 'svg';
	if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
	if (lower.endsWith('.mmd') || lower.endsWith('.mermaid')) return 'mermaid';
	return 'code';
}

function inferLanguage(path: string): string | undefined {
	const ext = path.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'ts':
			return 'typescript';
		case 'tsx':
			return 'tsx';
		case 'js':
			return 'javascript';
		case 'jsx':
			return 'jsx';
		case 'py':
			return 'python';
		case 'rs':
			return 'rust';
		case 'go':
			return 'go';
		case 'java':
			return 'java';
		case 'c':
			return 'c';
		case 'cpp':
		case 'cc':
			return 'cpp';
		case 'h':
			return 'c';
		case 'hpp':
			return 'cpp';
		case 'rb':
			return 'ruby';
		case 'php':
			return 'php';
		case 'sh':
			return 'bash';
		case 'csv':
			return 'csv';
		case 'json':
			return 'json';
		case 'yaml':
		case 'yml':
			return 'yaml';
		case 'xml':
			return 'xml';
		case 'sql':
			return 'sql';
		case 'css':
			return 'css';
		case 'scss':
		case 'sass':
			return 'scss';
		case 'html':
		case 'htm':
			return 'html';
		case 'md':
			return 'markdown';
		default:
			return undefined;
	}
}

export const sandboxCreateArtifactTool: Tool = {
	definition: {
		name: 'sandbox_create_artifact',
		description:
			'Read a file from the sandbox and expose it as a visual artifact in the conversation. Use this to share code, HTML pages, SVG images, markdown documents, or mermaid diagrams with the user. The artifact will appear in the side panel for easy viewing.',
		inputSchema: createArtifactInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const parsed = safeValidate(createArtifactArgsSchema, input);
		if (!parsed.ok) {
			return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
		}
		const args = parsed.value;
		try {
			await ensureWorkspaceReady(ctx);
			const sandbox = getConversationSandbox(ctx);
			const file = await sandbox.readFile(args.path);
			const type = args.type ?? inferArtifactType(args.path);
			const name = args.name ?? args.path.split('/').pop() ?? args.path;
			const language = args.language ?? (type === 'code' ? inferLanguage(args.path) : undefined);

			return {
				content: `Created artifact from ${args.path}`,
				artifacts: [
					{
						type,
						name,
						...(language ? { language } : {}),
						content: file.content,
					},
				],
			};
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	},
};

// ---------------------------------------------------------------------------
// sandbox_load_image
// ---------------------------------------------------------------------------
// Reads an image file from the conversation's R2 workspace prefix, encodes
// it as base64, and returns it as image content for the next LLM turn.
// Gated on the current model's `supportsImageInput` flag — non-vision models
// see a text fallback steering the agent to existing sandbox tools.

const IMAGE_EXTENSIONS: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/jpeg',
};

// Cap the in-context image size. Provider request bodies and token
// economy both suffer when an image is too large; agents should resize
// via `sandbox_exec` (e.g. ImageMagick) before reloading.
const MAX_IMAGE_BYTES = 3584 * 1024;

const loadImageInputSchema = {
	type: 'object',
	properties: {
		path: {
			type: 'string',
			description: 'Absolute path under /workspace, e.g. /workspace/uploads/foo.png.',
		},
	},
	required: ['path'],
} as const;

export type SandboxLoadImageDeps = {
	// Returns the current snapshot of configured provider models. Called per
	// invocation so a `switch_model` mid-turn picks up the new model's flags.
	getModels: () => ProviderModel[];
};

function bytesToBase64(bytes: Uint8Array): string {
	// Build the binary string in chunks to avoid `Maximum call stack size
	// exceeded` on large files when spreading into String.fromCharCode.
	const CHUNK = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
	}
	return btoa(binary);
}

export function createSandboxLoadImageTool(deps: SandboxLoadImageDeps): Tool {
	return {
		definition: {
			name: 'sandbox_load_image',
			description:
				"Load an image from the conversation's /workspace into the model's context as a vision-readable image. Supported formats: PNG, JPEG, GIF, WEBP. The current model must accept image input — for non-vision models, this tool returns text guidance pointing you at sandbox_read_file or sandbox_exec instead. Images larger than 3.5 MB are automatically resized when the image processing service is configured; otherwise use sandbox_exec (e.g. ImageMagick) to resize before loading.",
			inputSchema: loadImageInputSchema,
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(pathOnlyArgsSchema, input);
			if (!parsed.ok) {
				return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
			}
			const path = parsed.value.path;
			if (!path.startsWith('/workspace/')) {
				return {
					content: 'Path must start with /workspace/.',
					isError: true,
					errorCode: 'invalid_input',
				};
			}
			const ext = path.split('.').pop()?.toLowerCase() ?? '';
			const mimeType = IMAGE_EXTENSIONS[ext];
			if (!mimeType) {
				return {
					content: `Unsupported image extension: .${ext}. Supported: ${Object.keys(IMAGE_EXTENSIONS).join(', ')}. For non-image files, use sandbox_read_file or sandbox_exec.`,
					isError: true,
					errorCode: 'invalid_input',
				};
			}

			// Look up the current model's vision capability. The DO threads the
			// live (post-switch) model id into ctx.modelId, so this tracks
			// `switch_model` calls within the same turn.
			let supportsImageInput = false;
			try {
				const { providerId, modelId } = parseGlobalModelId(ctx.modelId);
				const model = deps.getModels().find((m) => m.providerId === providerId && m.id === modelId);
				supportsImageInput = !!model?.supportsImageInput;
			} catch {
				// Malformed model id — treat as non-vision.
			}

			const bucket = ctx.env.WORKSPACE_BUCKET;
			if (!bucket) {
				return { content: 'Workspace bucket not configured.', isError: true };
			}
			const key = `conversations/${ctx.conversationId}/${path.slice('/workspace/'.length)}`;
			const obj = await bucket.get(key);
			if (!obj) {
				return {
					content: `File not found: ${path}`,
					isError: true,
					errorCode: 'not_found',
				};
			}
			const size = obj.size;
			const tooBig = size > MAX_IMAGE_BYTES;
			const mb = (size / (1024 * 1024)).toFixed(1);
			const tooBigError = {
				content: `Image too large to load (${mb} MB > 3.5 MB). Use sandbox_exec to resize the image (e.g. \`convert ${path} -resize 1024x1024\\> ${path.replace(/(\.[^.]+)$/, '.small$1')}\`) and load the resized copy.`,
				isError: true as const,
			};

			if (tooBig && !ctx.env.IMAGES) {
				return tooBigError;
			}

			if (!supportsImageInput) {
				return {
					content: `Current model (${ctx.modelId}) does not accept image input. To inspect this file, use sandbox_read_file (text) or sandbox_exec (e.g. \`file ${path}\`, \`identify ${path}\`, OCR via tesseract). To switch to a vision-capable model, call switch_model.`,
					isError: false,
				};
			}

			const bytes = new Uint8Array(await obj.arrayBuffer());
			const filename = path.split('/').pop() ?? path;

			// Use the Images binding to resize before encoding. DO SQLite has a
			// 2 MB per-value limit; a raw 5 MB image hits that after base64 encoding.
			// Resizing to ≤1568 px on each side keeps the encoded blob well under
			// the limit while preserving useful detail for vision models.
			if (ctx.env.IMAGES) {
				try {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(bytes);
							controller.close();
						},
					});
					const resizedResponse = (
						await ctx.env.IMAGES.input(stream).transform({ width: 1568, height: 1568, fit: 'scale-down' }).output({ format: 'image/jpeg' })
					).response();
					const resizedBytes = new Uint8Array(await resizedResponse.arrayBuffer());
					const resizedBase64 = bytesToBase64(resizedBytes);
					return {
						content: [
							{
								type: 'text',
								text: `Loaded ${filename} (image/jpeg, ${resizedBytes.length} bytes) into context.`,
							},
							{
								type: 'image',
								mimeType: 'image/jpeg',
								data: resizedBase64,
							},
						],
					};
				} catch {
					if (tooBig) {
						return tooBigError;
					}
					// Fall through to the unresized path below.
				}
			}

			const base64 = bytesToBase64(bytes);
			return {
				content: [
					{
						type: 'text',
						text: `Loaded ${filename} (${mimeType}, ${size} bytes) into context.`,
					},
					{
						type: 'image',
						mimeType,
						data: base64,
					},
				],
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Registry helper
// ---------------------------------------------------------------------------
export type SandboxToolDeps = {
	loadImage?: SandboxLoadImageDeps;
};

export function registerSandboxTools(registry: { register(tool: Tool): void }, deps: SandboxToolDeps = {}): void {
	registry.register(sandboxExecTool);
	registry.register(sandboxRunCodeTool);
	registry.register(sandboxReadFileTool);
	registry.register(sandboxWriteFileTool);
	registry.register(sandboxDeleteFileTool);
	registry.register(sandboxMkdirTool);
	registry.register(sandboxExistsTool);
	registry.register(sandboxCreateArtifactTool);
	if (deps.loadImage) {
		registry.register(createSandboxLoadImageTool(deps.loadImage));
	}
}
