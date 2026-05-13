import {
	type CustomToolRow,
	createCustomTool,
	getCustomTool,
	getCustomToolByName,
	listCustomTools,
	secretKeys,
	updateCustomTool,
} from '../custom_tools';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

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
		description:
			'List all user-defined custom tools (id, name, description, enabled). Use this before create_custom_tool to avoid name collisions, or to find an existing tool to update.',
		inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
		name: 'list_custom_tools',
	},
	async execute(ctx: ToolContext): Promise<ToolExecutionResult> {
		const tools = await listCustomTools(ctx.env);
		if (tools.length === 0) return { content: 'No custom tools defined yet.' };
		const summary = tools.map((t) => ({
			description: t.description,
			enabled: t.enabled,
			id: t.id,
			name: t.name,
		}));
		return { content: JSON.stringify(summary, null, 2) };
	},
};

export const getCustomToolTool: Tool = {
	definition: {
		description:
			"Read a custom tool's full definition (source, input_schema, description, secret keys). Pass either id or name. Secret values are redacted — only the key names are returned.",
		inputSchema: {
			properties: {
				id: { description: 'Tool id (preferred).', type: 'integer' },
				name: { description: 'Tool name (alternative to id).', type: 'string' },
			},
			type: 'object',
		},
		name: 'get_custom_tool',
	},
	async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
		const args = (input ?? {}) as { id?: number; name?: string };
		let row: CustomToolRow | null;
		if (typeof args.id === 'number') {
			row = await getCustomTool(ctx.env, args.id);
		} else if (typeof args.name === 'string' && args.name) {
			row = await getCustomToolByName(ctx.env, args.name);
		} else {
			return {
				content: 'Provide either `id` or `name`.',
				errorCode: 'invalid_input',
				isError: true,
			};
		}
		if (!row) {
			return { content: 'Custom tool not found.', errorCode: 'not_found', isError: true };
		}
		return {
			content: JSON.stringify(
				{
					description: row.description,
					enabled: row.enabled,
					id: row.id,
					input_schema: safeParseJson(row.inputSchema),
					name: row.name,
					secret_keys: secretKeys(row.secretsJson),
					source: row.source,
				},
				null,
				2,
			),
		};
	},
};

export const createCustomToolTool: Tool = {
	definition: {
		description: `Create a new custom tool the agent can call on subsequent turns. The new tool is NOT available in the current turn — finish your reply and the user will see it on the next call. ${TOOL_AUTHOR_GUIDE}`,
		inputSchema: {
			properties: {
				description: {
					description: 'Short description shown to the LLM. Be specific about what the tool does and when to use it.',
					type: 'string',
				},
				input_schema: {
					description:
						"JSON Schema for the tool's `input` argument. Must be a JSON Schema object (typically `{type:'object', properties:{...}}`).",
					type: 'object',
				},
				name: {
					description: 'Tool name (snake_case, must start with a letter, no `mcp_` or `custom_` prefix, no collision with built-in tools).',
					type: 'string',
				},
				secrets: {
					additionalProperties: { type: 'string' },
					description:
						"Optional map of API keys / secrets passed as the loaded worker's `env`. The user can edit these in the UI — prefer asking the user to provide them rather than hardcoding.",
					type: 'object',
				},
				source: {
					description: 'Full ES module source — see the format above.',
					type: 'string',
				},
			},
			required: ['name', 'description', 'source', 'input_schema'],
			type: 'object',
		},
		name: 'create_custom_tool',
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
			return { content: '`name` is required.', errorCode: 'invalid_input', isError: true };
		}
		if (!args.description || typeof args.description !== 'string') {
			return { content: '`description` is required.', errorCode: 'invalid_input', isError: true };
		}
		if (!args.source || typeof args.source !== 'string') {
			return { content: '`source` is required.', errorCode: 'invalid_input', isError: true };
		}
		if (args.input_schema === undefined || args.input_schema === null) {
			return { content: '`input_schema` is required.', errorCode: 'invalid_input', isError: true };
		}
		const inputSchemaJson = typeof args.input_schema === 'string' ? args.input_schema : JSON.stringify(args.input_schema);
		const secretsJson = args.secrets && typeof args.secrets === 'object' ? JSON.stringify(args.secrets) : null;
		try {
			const id = await createCustomTool(ctx.env, {
				description: args.description,
				inputSchema: inputSchemaJson,
				name: args.name,
				secretsJson,
				source: args.source,
			});
			return {
				content: `Created custom tool #${id} "${args.name}". It will appear in your tool list on the next turn as \`custom_${id}_${args.name}\`.`,
			};
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				errorCode: 'invalid_input',
				isError: true,
			};
		}
	},
};

export const updateCustomToolTool: Tool = {
	definition: {
		description: `Update one or more fields of an existing custom tool. The change applies on the next turn. ${TOOL_AUTHOR_GUIDE}`,
		inputSchema: {
			properties: {
				description: { type: 'string' },
				enabled: { type: 'boolean' },
				id: { type: 'integer' },
				input_schema: { type: 'object' },
				name: { type: 'string' },
				secrets: {
					additionalProperties: { type: 'string' },
					description: 'Replace the secrets blob entirely. Pass an empty object to clear. Omit to leave secrets unchanged.',
					type: 'object',
				},
				source: { type: 'string' },
			},
			required: ['id'],
			type: 'object',
		},
		name: 'update_custom_tool',
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
			return { content: '`id` is required.', errorCode: 'invalid_input', isError: true };
		}
		const patch: Parameters<typeof updateCustomTool>[2] = {};
		if (args.name !== undefined) {
			if (typeof args.name !== 'string') {
				return { content: '`name` must be a string.', errorCode: 'invalid_input', isError: true };
			}
			patch.name = args.name;
		}
		if (args.description !== undefined) {
			if (typeof args.description !== 'string') {
				return { content: '`description` must be a string.', errorCode: 'invalid_input', isError: true };
			}
			patch.description = args.description;
		}
		if (args.source !== undefined) {
			if (typeof args.source !== 'string') {
				return { content: '`source` must be a string.', errorCode: 'invalid_input', isError: true };
			}
			patch.source = args.source;
		}
		if (args.input_schema !== undefined) {
			patch.inputSchema = typeof args.input_schema === 'string' ? args.input_schema : JSON.stringify(args.input_schema);
		}
		if (args.secrets !== undefined) {
			patch.secretsJson = args.secrets && typeof args.secrets === 'object' ? JSON.stringify(args.secrets) : null;
		}
		if (args.enabled !== undefined) {
			if (typeof args.enabled !== 'boolean') {
				return { content: '`enabled` must be a boolean.', errorCode: 'invalid_input', isError: true };
			}
			patch.enabled = args.enabled;
		}
		try {
			await updateCustomTool(ctx.env, args.id, patch);
			return { content: `Updated custom tool #${args.id}. Changes apply on the next turn.` };
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				errorCode: 'invalid_input',
				isError: true,
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

export const customToolMetaTools: Tool[] = [listCustomToolsTool, getCustomToolTool, createCustomToolTool, updateCustomToolTool];
