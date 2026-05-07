import type { Tool, ToolContext, ToolExecutionResult } from './registry';
import {
	createCustomTool,
	getCustomTool,
	getCustomToolByName,
	listCustomTools,
	secretKeys,
	updateCustomTool,
} from '../custom_tools';

const TOOL_AUTHOR_GUIDE = `Tool source must be a complete ES module that exports a default WorkerEntrypoint subclass with an async run(input) method, e.g.:

import { WorkerEntrypoint } from 'cloudflare:workers';
export default class extends WorkerEntrypoint {
  async run(input) {
    // input is the JSON object the caller passed (matches input_schema)
    // this.env contains the secrets you registered for this tool
    const res = await fetch('https://example.com/api?q=' + encodeURIComponent(input.q));
    return await res.json();
  }
}

The return value of run() is JSON-serialized and shown back to the agent. Throwing an error makes the tool result an error.`;

export const listCustomToolsTool: Tool = {
	definition: {
		name: 'list_custom_tools',
		description:
			'List all user-defined custom tools (id, name, description, enabled). Use this before create_custom_tool to avoid name collisions, or to find an existing tool to update.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	async execute(ctx: ToolContext): Promise<ToolExecutionResult> {
		const tools = await listCustomTools(ctx.env);
		if (tools.length === 0) return { content: 'No custom tools defined yet.' };
		const summary = tools.map((t) => ({
			id: t.id,
			name: t.name,
			description: t.description,
			enabled: t.enabled,
		}));
		return { content: JSON.stringify(summary, null, 2) };
	},
};

export const getCustomToolTool: Tool = {
	definition: {
		name: 'get_custom_tool',
		description:
			"Read a custom tool's full definition (source, input_schema, description, secret keys). Pass either id or name. Secret values are redacted — only the key names are returned.",
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'integer', description: 'Tool id (preferred).' },
				name: { type: 'string', description: 'Tool name (alternative to id).' },
			},
		},
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as { id?: number; name?: string };
		let row;
		if (typeof args.id === 'number') {
			row = await getCustomTool(ctx.env, args.id);
		} else if (typeof args.name === 'string' && args.name) {
			row = await getCustomToolByName(ctx.env, args.name);
		} else {
			return {
				content: 'Provide either `id` or `name`.',
				isError: true,
				errorCode: 'invalid_input',
			};
		}
		if (!row) {
			return { content: 'Custom tool not found.', isError: true, errorCode: 'not_found' };
		}
		return {
			content: JSON.stringify(
				{
					id: row.id,
					name: row.name,
					description: row.description,
					enabled: row.enabled,
					input_schema: safeParseJson(row.inputSchema),
					source: row.source,
					secret_keys: secretKeys(row.secretsJson),
				},
				null,
				2,
			),
		};
	},
};

export const createCustomToolTool: Tool = {
	definition: {
		name: 'create_custom_tool',
		description:
			`Create a new custom tool the agent can call on subsequent turns. The new tool is NOT available in the current turn — finish your reply and the user will see it on the next call. ${TOOL_AUTHOR_GUIDE}`,
		inputSchema: {
			type: 'object',
			required: ['name', 'description', 'source', 'input_schema'],
			properties: {
				name: {
					type: 'string',
					description:
						'Tool name (snake_case, must start with a letter, no `mcp_` or `custom_` prefix, no collision with built-in tools).',
				},
				description: {
					type: 'string',
					description: 'Short description shown to the LLM. Be specific about what the tool does and when to use it.',
				},
				source: {
					type: 'string',
					description: 'Full ES module source — see the format above.',
				},
				input_schema: {
					type: 'object',
					description: "JSON Schema for the tool's `input` argument. Must be a JSON Schema object (typically `{type:'object', properties:{...}}`).",
				},
				secrets: {
					type: 'object',
					description:
						'Optional map of API keys / secrets passed as the loaded worker\'s `env`. The user can edit these in the UI — prefer asking the user to provide them rather than hardcoding.',
					additionalProperties: { type: 'string' },
				},
			},
		},
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as {
			name?: string;
			description?: string;
			source?: string;
			input_schema?: unknown;
			secrets?: Record<string, unknown>;
		};
		if (!args.name || typeof args.name !== 'string') {
			return { content: '`name` is required.', isError: true, errorCode: 'invalid_input' };
		}
		if (!args.description || typeof args.description !== 'string') {
			return { content: '`description` is required.', isError: true, errorCode: 'invalid_input' };
		}
		if (!args.source || typeof args.source !== 'string') {
			return { content: '`source` is required.', isError: true, errorCode: 'invalid_input' };
		}
		if (args.input_schema === undefined || args.input_schema === null) {
			return { content: '`input_schema` is required.', isError: true, errorCode: 'invalid_input' };
		}
		const inputSchemaJson =
			typeof args.input_schema === 'string' ? args.input_schema : JSON.stringify(args.input_schema);
		const secretsJson =
			args.secrets && typeof args.secrets === 'object'
				? JSON.stringify(args.secrets)
				: null;
		try {
			const id = await createCustomTool(ctx.env, {
				name: args.name,
				description: args.description,
				source: args.source,
				inputSchema: inputSchemaJson,
				secretsJson,
			});
			return {
				content: `Created custom tool #${id} "${args.name}". It will appear in your tool list on the next turn as \`custom_${id}_${args.name}\`.`,
			};
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
				errorCode: 'invalid_input',
			};
		}
	},
};

export const updateCustomToolTool: Tool = {
	definition: {
		name: 'update_custom_tool',
		description: `Update one or more fields of an existing custom tool. The change applies on the next turn. ${TOOL_AUTHOR_GUIDE}`,
		inputSchema: {
			type: 'object',
			required: ['id'],
			properties: {
				id: { type: 'integer' },
				name: { type: 'string' },
				description: { type: 'string' },
				source: { type: 'string' },
				input_schema: { type: 'object' },
				secrets: {
					type: 'object',
					description:
						'Replace the secrets blob entirely. Pass an empty object to clear. Omit to leave secrets unchanged.',
					additionalProperties: { type: 'string' },
				},
				enabled: { type: 'boolean' },
			},
		},
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as {
			id?: number;
			name?: string;
			description?: string;
			source?: string;
			input_schema?: unknown;
			secrets?: Record<string, unknown>;
			enabled?: boolean;
		};
		if (typeof args.id !== 'number') {
			return { content: '`id` is required.', isError: true, errorCode: 'invalid_input' };
		}
		const patch: Parameters<typeof updateCustomTool>[2] = {};
		if (args.name !== undefined) patch.name = args.name;
		if (args.description !== undefined) patch.description = args.description;
		if (args.source !== undefined) patch.source = args.source;
		if (args.input_schema !== undefined) {
			patch.inputSchema =
				typeof args.input_schema === 'string'
					? args.input_schema
					: JSON.stringify(args.input_schema);
		}
		if (args.secrets !== undefined) {
			patch.secretsJson =
				args.secrets && typeof args.secrets === 'object'
					? JSON.stringify(args.secrets)
					: null;
		}
		if (args.enabled !== undefined) patch.enabled = args.enabled;
		try {
			await updateCustomTool(ctx.env, args.id, patch);
			return { content: `Updated custom tool #${args.id}. Changes apply on the next turn.` };
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
				errorCode: 'invalid_input',
			};
		}
	},
};

function safeParseJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return s;
	}
}

export const customToolMetaTools: Tool[] = [
	listCustomToolsTool,
	getCustomToolTool,
	createCustomToolTool,
	updateCustomToolTool,
];
