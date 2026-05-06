import { getSandbox, parseSSEStream } from '@cloudflare/sandbox';
import type { Sandbox, ExecEvent, ExecResult } from '@cloudflare/sandbox';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

// ---------------------------------------------------------------------------
// Helper: resolve a sandbox instance scoped to the current conversation.
// ---------------------------------------------------------------------------
function getConversationSandbox(ctx: ToolContext) {
	if (!ctx.env.SANDBOX) {
		throw new Error('Sandbox binding is not configured.');
	}
	return getSandbox(ctx.env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, ctx.conversationId);
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
// R2 /workspace mount
// ---------------------------------------------------------------------------
// When `WORKSPACE_BUCKET` is bound, mount it at /workspace so files written
// there sync to R2. Each conversation gets its own bucket prefix so files
// are isolated across conversations.
//
// We prefer FUSE mode (s3fs inside the container) whenever R2 S3-API
// credentials are configured. FUSE talks directly to R2 from the container
// process — there are no background loops in the Durable Object that can
// die when the DO is evicted. The earlier `localBucket: true` mode looked
// nicer (no secrets needed) but its bidirectional sync ran setTimeout/SSE
// loops inside the Sandbox DO, which Cloudflare evicts from memory shortly
// after the originating RPC returns; the loops never made it past the next
// tick, so container→R2 uploads never happened in production.
//
// `localBucket: true` is retained as a fallback for `wrangler dev`, where
// the DO process is long-lived and the sync loops actually get to run.
//
// The mount lives on the Sandbox Durable Object (the SDK tracks it in
// `activeMounts`), and the DO can be evicted independently of this Worker
// isolate — so we must NOT cache "already mounted" at the Worker level.
// Always call `mountBucket`; the SDK throws a tolerable
// "Mount path already in use" error when the mount is already live.
// Default matches `r2_buckets[0].bucket_name` in wrangler.jsonc. Override
// via the `R2_WORKSPACE_BUCKET_NAME` secret if you renamed the bucket.
const DEFAULT_R2_BUCKET_NAME = 'interface-workspace';

function r2Endpoint(env: Env): string | undefined {
	if (env.R2_ENDPOINT) return env.R2_ENDPOINT;
	if (env.R2_ACCOUNT_ID) return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
	return undefined;
}

export async function ensureWorkspaceMount(ctx: ToolContext): Promise<void> {
	if (!ctx.env.WORKSPACE_BUCKET) return;
	const sandbox = getConversationSandbox(ctx);
	const prefix = `/conversations/${ctx.conversationId}`;
	const endpoint = r2Endpoint(ctx.env);
	const accessKeyId = ctx.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = ctx.env.R2_SECRET_ACCESS_KEY;
	const bucketName = ctx.env.R2_WORKSPACE_BUCKET_NAME ?? DEFAULT_R2_BUCKET_NAME;
	try {
		if (endpoint && accessKeyId && secretAccessKey) {
			await sandbox.mountBucket(bucketName, '/workspace', {
				endpoint,
				provider: 'r2',
				credentials: { accessKeyId, secretAccessKey },
				prefix,
			});
		} else {
			await sandbox.mountBucket('WORKSPACE_BUCKET', '/workspace', {
				localBucket: true,
				prefix,
			});
		}
	} catch (e) {
		if (!(e instanceof Error) || !/already (mount|in use)/i.test(e.message)) throw e;
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
		const args = (input ?? {}) as {
			command?: string;
			cwd?: string;
			env?: Record<string, string>;
			stdin?: string;
			timeout?: number;
		};
		if (!args.command || typeof args.command !== 'string') {
			return { content: 'Missing required parameter: command', isError: true };
		}
		const cwd = args.cwd ?? '/workspace';
		try {
			await ensureWorkspaceMount(ctx);
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
				let stdout = '';
				let stderr = '';
				let exitCode: number | undefined;
				for await (const ev of parseSSEStream<ExecEvent>(stream, ctx.signal)) {
					if (ev.type === 'stdout' || ev.type === 'stderr') {
						if (ev.data) {
							if (ev.type === 'stdout') stdout += ev.data;
							if (ev.type === 'stderr') stderr += ev.data;
							ctx.emitToolOutput(ev.data);
						}
					} else if (ev.type === 'complete') {
						exitCode = ev.exitCode;
						break;
					} else if (ev.type === 'error') {
						return { content: ev.data ?? ev.error ?? 'Exec stream error', isError: true };
					}
				}
				if (exitCode === undefined) {
					const partial = ['Exec stream ended without completion'];
					if (stdout) partial.push('', '--- stdout ---', stdout);
					if (stderr) partial.push('', '--- stderr ---', stderr);
					return { content: partial.join('\n'), isError: true };
				}
				return formatExecResult({ success: exitCode === 0, exitCode, stdout, stderr });
			}
			const result = await sandbox.exec(args.command, {
				cwd,
				...(args.env ? { env: args.env } : {}),
				...(args.stdin ? { stdin: args.stdin } : {}),
				...(args.timeout ? { timeout: args.timeout } : {}),
			});
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
		const args = (input ?? {}) as {
			code?: string;
			language?: string;
			timeout?: number;
		};
		if (!args.code || typeof args.code !== 'string') {
			return { content: 'Missing required parameter: code', isError: true };
		}
		const language = (args.language ?? 'python') as 'python' | 'javascript' | 'typescript';
		if (!['python', 'javascript', 'typescript'].includes(language)) {
			return { content: `Unsupported language: ${language}`, isError: true };
		}
		try {
			await ensureWorkspaceMount(ctx);
			await ensureSshKey(ctx);
			const sandbox = getConversationSandbox(ctx);
			const result = await sandbox.runCode(args.code, {
				language,
				...(args.timeout ? { timeout: args.timeout } : {}),
			});
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
		const args = (input ?? {}) as { path?: string };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
			await ensureWorkspaceMount(ctx);
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
		const args = (input ?? {}) as { path?: string; content?: string };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		if (args.content === undefined || typeof args.content !== 'string') {
			return { content: 'Missing required parameter: content', isError: true };
		}
		try {
			await ensureWorkspaceMount(ctx);
			const sandbox = getConversationSandbox(ctx);
			await sandbox.writeFile(args.path, args.content);
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
		const args = (input ?? {}) as { path?: string };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
			await ensureWorkspaceMount(ctx);
			const sandbox = getConversationSandbox(ctx);
			await sandbox.deleteFile(args.path);
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
		const args = (input ?? {}) as { path?: string; recursive?: boolean };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
			await ensureWorkspaceMount(ctx);
			const sandbox = getConversationSandbox(ctx);
			await sandbox.mkdir(args.path, { recursive: !!args.recursive });
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
		const args = (input ?? {}) as { path?: string };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
			await ensureWorkspaceMount(ctx);
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
			"Read a file from the sandbox and expose it as a visual artifact in the conversation. Use this to share code, HTML pages, SVG images, markdown documents, or mermaid diagrams with the user. The artifact will appear in the side panel for easy viewing.",
		inputSchema: createArtifactInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as {
			path?: string;
			type?: 'code' | 'markdown' | 'html' | 'svg' | 'mermaid';
			name?: string;
			language?: string;
		};
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
			await ensureWorkspaceMount(ctx);
			const sandbox = getConversationSandbox(ctx);
			const file = await sandbox.readFile(args.path);
			const type = args.type ?? inferArtifactType(args.path);
			const name = args.name ?? args.path.split('/').pop() ?? args.path;
			const language =
				args.language ?? (type === 'code' ? inferLanguage(args.path) : undefined);

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
// Registry helper
// ---------------------------------------------------------------------------
export function registerSandboxTools(registry: { register(tool: Tool): void }): void {
	registry.register(sandboxExecTool);
	registry.register(sandboxRunCodeTool);
	registry.register(sandboxReadFileTool);
	registry.register(sandboxWriteFileTool);
	registry.register(sandboxDeleteFileTool);
	registry.register(sandboxMkdirTool);
	registry.register(sandboxExistsTool);
	registry.register(sandboxCreateArtifactTool);
}
