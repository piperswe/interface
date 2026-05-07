import { now as nowMs } from './clock';

const SINGLE_USER_ID = 1;

// Names of all built-in tools — custom tools cannot collide with these.
// Keep in sync with the tools registered in tool-registry-builder.ts.
const BUILTIN_TOOL_NAMES = new Set<string>([
	'fetch_url',
	'remember',
	'web_search',
	'run_js',
	'sandbox_exec',
	'sandbox_run_code',
	'sandbox_load_image',
	'switch_model',
	'get_models',
	'agent',
	'ynab_get_user',
	'ynab_list_budgets',
	'ynab_get_month',
	'ynab_list_accounts',
	'ynab_list_categories',
	'ynab_list_payees',
	'ynab_list_transactions',
	'ynab_create_transaction',
	'ynab_update_transaction',
	'ynab_update_category_budgeted',
	'openweather_current',
	'openweather_forecast',
	'openweather_geocode',
	'openweather_reverse_geocode',
	'list_custom_tools',
	'get_custom_tool',
	'create_custom_tool',
	'update_custom_tool',
]);

// Reserved prefixes for system-namespaced tools.
const RESERVED_PREFIXES = ['mcp_', 'custom_'];

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export type CustomToolRow = {
	id: number;
	name: string;
	description: string;
	source: string;
	inputSchema: string;
	secretsJson: string | null;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
};

type Row = {
	id: number;
	name: string;
	description: string;
	source: string;
	input_schema: string;
	secrets_json: string | null;
	enabled: number;
	created_at: number;
	updated_at: number;
};

const SELECT_COLS = `id, name, description, source, input_schema, secrets_json, enabled, created_at, updated_at`;

function rowToTool(r: Row): CustomToolRow {
	return {
		id: r.id,
		name: r.name,
		description: r.description,
		source: r.source,
		inputSchema: r.input_schema,
		secretsJson: r.secrets_json,
		enabled: r.enabled === 1,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export function isValidCustomToolName(name: string): boolean {
	if (!NAME_PATTERN.test(name)) return false;
	if (BUILTIN_TOOL_NAMES.has(name)) return false;
	for (const prefix of RESERVED_PREFIXES) {
		if (name.startsWith(prefix)) return false;
	}
	return true;
}

export function customToolNameError(name: string): string | null {
	if (!NAME_PATTERN.test(name)) {
		return 'Name must start with a letter and contain only lowercase letters, digits, and underscores (max 63 chars).';
	}
	if (BUILTIN_TOOL_NAMES.has(name)) {
		return `"${name}" is the name of a built-in tool.`;
	}
	for (const prefix of RESERVED_PREFIXES) {
		if (name.startsWith(prefix)) {
			return `Name cannot start with "${prefix}" — that prefix is reserved.`;
		}
	}
	return null;
}

export async function listCustomTools(env: Env, userId: number = SINGLE_USER_ID): Promise<CustomToolRow[]> {
	const result = await env.DB.prepare(
		`SELECT ${SELECT_COLS} FROM custom_tools WHERE user_id = ? ORDER BY name`,
	)
		.bind(userId)
		.all<Row>();
	return (result.results ?? []).map(rowToTool);
}

export async function getCustomTool(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<CustomToolRow | null> {
	const row = await env.DB.prepare(
		`SELECT ${SELECT_COLS} FROM custom_tools WHERE id = ? AND user_id = ?`,
	)
		.bind(id, userId)
		.first<Row>();
	return row ? rowToTool(row) : null;
}

export async function getCustomToolByName(
	env: Env,
	name: string,
	userId: number = SINGLE_USER_ID,
): Promise<CustomToolRow | null> {
	const row = await env.DB.prepare(
		`SELECT ${SELECT_COLS} FROM custom_tools WHERE name = ? AND user_id = ?`,
	)
		.bind(name, userId)
		.first<Row>();
	return row ? rowToTool(row) : null;
}

export type CreateCustomToolInput = {
	name: string;
	description: string;
	source: string;
	inputSchema: string;
	secretsJson?: string | null;
};

export async function createCustomTool(
	env: Env,
	input: CreateCustomToolInput,
	userId: number = SINGLE_USER_ID,
): Promise<number> {
	const nameErr = customToolNameError(input.name);
	if (nameErr) throw new Error(nameErr);
	if (!input.description.trim()) throw new Error('Description is required.');
	if (!input.source.trim()) throw new Error('Source is required.');
	try {
		JSON.parse(input.inputSchema);
	} catch {
		throw new Error('input_schema must be valid JSON.');
	}
	if (input.secretsJson) {
		try {
			const parsed = JSON.parse(input.secretsJson);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error('secrets_json must be a JSON object.');
			}
		} catch {
			throw new Error('secrets_json must be valid JSON.');
		}
	}

	const existing = await getCustomToolByName(env, input.name, userId);
	if (existing) throw new Error(`A tool named "${input.name}" already exists.`);

	const ts = nowMs();
	const result = await env.DB.prepare(
		`INSERT INTO custom_tools (user_id, name, description, source, input_schema, secrets_json, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
		 RETURNING id`,
	)
		.bind(
			userId,
			input.name,
			input.description,
			input.source,
			input.inputSchema,
			input.secretsJson ?? null,
			ts,
			ts,
		)
		.first<{ id: number }>();
	if (!result) throw new Error('Failed to create custom tool.');
	return result.id;
}

export type UpdateCustomToolPatch = {
	name?: string;
	description?: string;
	source?: string;
	inputSchema?: string;
	secretsJson?: string | null;
	enabled?: boolean;
};

export async function updateCustomTool(
	env: Env,
	id: number,
	patch: UpdateCustomToolPatch,
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	const sets: string[] = [];
	const values: unknown[] = [];

	if (patch.name !== undefined) {
		const nameErr = customToolNameError(patch.name);
		if (nameErr) throw new Error(nameErr);
		const collision = await getCustomToolByName(env, patch.name, userId);
		if (collision && collision.id !== id) {
			throw new Error(`A tool named "${patch.name}" already exists.`);
		}
		sets.push('name = ?');
		values.push(patch.name);
	}
	if (patch.description !== undefined) {
		if (!patch.description.trim()) throw new Error('Description is required.');
		sets.push('description = ?');
		values.push(patch.description);
	}
	if (patch.source !== undefined) {
		if (!patch.source.trim()) throw new Error('Source is required.');
		sets.push('source = ?');
		values.push(patch.source);
	}
	if (patch.inputSchema !== undefined) {
		try {
			JSON.parse(patch.inputSchema);
		} catch {
			throw new Error('input_schema must be valid JSON.');
		}
		sets.push('input_schema = ?');
		values.push(patch.inputSchema);
	}
	if (patch.secretsJson !== undefined) {
		if (patch.secretsJson) {
			try {
				const parsed = JSON.parse(patch.secretsJson);
				if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
					throw new Error('secrets_json must be a JSON object.');
				}
			} catch {
				throw new Error('secrets_json must be valid JSON.');
			}
		}
		sets.push('secrets_json = ?');
		values.push(patch.secretsJson ?? null);
	}
	if (patch.enabled !== undefined) {
		sets.push('enabled = ?');
		values.push(patch.enabled ? 1 : 0);
	}

	if (sets.length === 0) return;
	sets.push('updated_at = ?');
	values.push(nowMs());
	values.push(id);
	values.push(userId);

	await env.DB.prepare(
		`UPDATE custom_tools SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
	)
		.bind(...values)
		.run();
}

export async function deleteCustomTool(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare(`DELETE FROM custom_tools WHERE id = ? AND user_id = ?`).bind(id, userId).run();
}

export async function setCustomToolEnabled(
	env: Env,
	id: number,
	enabled: boolean,
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE custom_tools SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
	)
		.bind(enabled ? 1 : 0, nowMs(), id, userId)
		.run();
}

export function parseSecretsJson(json: string | null | undefined): Record<string, unknown> {
	if (!json) return {};
	try {
		const parsed = JSON.parse(json);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through
	}
	return {};
}

export function secretKeys(json: string | null | undefined): string[] {
	return Object.keys(parseSecretsJson(json));
}

export function parseInputSchema(json: string): object {
	try {
		const parsed = JSON.parse(json);
		if (parsed && typeof parsed === 'object') return parsed as object;
	} catch {
		// fall through
	}
	return { type: 'object' };
}
