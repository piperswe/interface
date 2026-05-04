import { getSandbox } from '@cloudflare/sandbox';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

// ---------------------------------------------------------------------------
// Helper: resolve a sandbox instance scoped to the current conversation.
// ---------------------------------------------------------------------------
function getConversationSandbox(ctx: ToolContext) {
	if (!ctx.env.SANDBOX) {
		throw new Error('Sandbox binding is not configured.');
	}
	return getSandbox(ctx.env.SANDBOX, ctx.conversationId);
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
			'Execute a shell command inside the conversation\'s isolated sandbox. Returns stdout, stderr, exit code, and success status. Use for running scripts, installing packages, compiling code, or any shell-level operation.',
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
		try {
			const sandbox = getConversationSandbox(ctx);
			const result = await sandbox.exec(args.command, {
				...(args.cwd ? { cwd: args.cwd } : {}),
				...(args.env ? { env: args.env } : {}),
				...(args.stdin ? { stdin: args.stdin } : {}),
				...(args.timeout ? { timeout: args.timeout } : {}),
			});
			const lines: string[] = [
				`exitCode: ${result.exitCode}`,
				`success: ${result.success}`,
			];
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
			'Execute Python, JavaScript, or TypeScript code inside the conversation\'s isolated sandbox. The default execution context is reused for the same language, so variables and imports persist across calls in this conversation. Returns the last expression result, stdout/stderr logs, and any execution errors. Use for data analysis, calculations, or any interpreted code.',
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
		description: 'Read the contents of a file from the conversation\'s sandbox filesystem.',
		inputSchema: readFileInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as { path?: string };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
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
		description: 'Write (or overwrite) a file in the conversation\'s sandbox filesystem.',
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
		description: 'Delete a file from the conversation\'s sandbox filesystem.',
		inputSchema: deleteFileInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as { path?: string };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
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
		description: 'Create a directory in the conversation\'s sandbox filesystem.',
		inputSchema: mkdirInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as { path?: string; recursive?: boolean };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
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
		description: 'Check whether a file or directory exists in the conversation\'s sandbox filesystem.',
		inputSchema: existsInputSchema,
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as { path?: string };
		if (!args.path || typeof args.path !== 'string') {
			return { content: 'Missing required parameter: path', isError: true };
		}
		try {
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
}
