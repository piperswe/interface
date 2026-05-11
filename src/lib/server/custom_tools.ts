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

// Caps to prevent unbounded growth (D1 row limits, system-prompt budget,
// cache-key rebuilds). Custom tool descriptions land in the LLM tool list
// on every turn, so a long description bloats every prompt.
export const MAX_TOOL_NAME_LEN = 64;
export const MAX_TOOL_DESCRIPTION_LEN = 1024;
export const MAX_TOOL_SOURCE_LEN = 64_000;
export const MAX_TOOL_SCHEMA_LEN = 8_000;
export const MAX_TOOL_SECRETS_LEN = 16_000;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Validate (and normalise) the secrets blob. The original validator only
// checked that the JSON was an object; values could be non-strings and keys
// could be `__proto__` / `constructor`. Both flow into the loaded Worker's
// `env`, where they violate the documented contract (string secret values)
// and seed prototype-pollution chains in any downstream consumer that does
// `Object.assign({}, secrets)`.
function validateSecretsJsonOrThrow(json: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error('secrets_json must be valid JSON.');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('secrets_json must be a JSON object.');
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (FORBIDDEN_KEYS.has(key)) {
			throw new Error(`secrets_json contains forbidden key: ${key}`);
		}
		if (typeof value !== 'string') {
			throw new Error(`secrets_json value for "${key}" must be a string.`);
		}
		out[key] = value;
	}
	return out;
}

// Validate the input_schema JSON — must be an object (not an array) with
// `type: "object"` if it specifies a top-level type.
function validateInputSchemaOrThrow(json: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error('input_schema must be valid JSON.');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('input_schema must be a JSON object.');
	}
	const t = (parsed as { type?: unknown }).type;
	if (t !== undefined && t !== 'object') {
		throw new Error('input_schema.type must be "object" (or omitted).');
	}
}

function validateLengthOrThrow(label: string, value: string, max: number): void {
	if (value.length > max) {
		throw new Error(`${label} exceeds maximum length of ${max} characters.`);
	}
}

export async function createCustomTool(
	env: Env,
	input: CreateCustomToolInput,
	userId: number = SINGLE_USER_ID,
): Promise<number> {
	if (typeof input.name !== 'string') throw new Error('Tool name must be a string.');
	if (typeof input.description !== 'string') throw new Error('Description must be a string.');
	if (typeof input.source !== 'string') throw new Error('Source must be a string.');
	if (typeof input.inputSchema !== 'string') throw new Error('input_schema must be a JSON string.');
	const nameErr = customToolNameError(input.name);
	if (nameErr) throw new Error(nameErr);
	if (!input.description.trim()) throw new Error('Description is required.');
	if (!input.source.trim()) throw new Error('Source is required.');
	validateLengthOrThrow('Tool name', input.name, MAX_TOOL_NAME_LEN);
	validateLengthOrThrow('Description', input.description, MAX_TOOL_DESCRIPTION_LEN);
	validateLengthOrThrow('Source', input.source, MAX_TOOL_SOURCE_LEN);
	validateLengthOrThrow('input_schema', input.inputSchema, MAX_TOOL_SCHEMA_LEN);
	validateInputSchemaOrThrow(input.inputSchema);
	if (input.secretsJson) {
		validateLengthOrThrow('secrets_json', input.secretsJson, MAX_TOOL_SECRETS_LEN);
		validateSecretsJsonOrThrow(input.secretsJson);
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
		if (typeof patch.name !== 'string') throw new Error('Tool name must be a string.');
		validateLengthOrThrow('Tool name', patch.name, MAX_TOOL_NAME_LEN);
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
		if (typeof patch.description !== 'string') throw new Error('Description must be a string.');
		if (!patch.description.trim()) throw new Error('Description is required.');
		validateLengthOrThrow('Description', patch.description, MAX_TOOL_DESCRIPTION_LEN);
		sets.push('description = ?');
		values.push(patch.description);
	}
	if (patch.source !== undefined) {
		if (typeof patch.source !== 'string') throw new Error('Source must be a string.');
		if (!patch.source.trim()) throw new Error('Source is required.');
		validateLengthOrThrow('Source', patch.source, MAX_TOOL_SOURCE_LEN);
		sets.push('source = ?');
		values.push(patch.source);
	}
	if (patch.inputSchema !== undefined) {
		if (typeof patch.inputSchema !== 'string') throw new Error('input_schema must be a JSON string.');
		validateLengthOrThrow('input_schema', patch.inputSchema, MAX_TOOL_SCHEMA_LEN);
		validateInputSchemaOrThrow(patch.inputSchema);
		sets.push('input_schema = ?');
		values.push(patch.inputSchema);
	}
	if (patch.secretsJson !== undefined) {
		if (patch.secretsJson) {
			validateLengthOrThrow('secrets_json', patch.secretsJson, MAX_TOOL_SECRETS_LEN);
			validateSecretsJsonOrThrow(patch.secretsJson);
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

// Defensive: never return `__proto__` / `constructor` / `prototype` as keys,
// and drop any non-string value. Validators upstream should already have
// rejected these, but legacy rows in D1 might have them. Returns a plain
// object (not Object.create(null)) so it round-trips through structured-
// clone when handed to the Worker loader as `env`.
export function parseSecretsJson(json: string | null | undefined): Record<string, string> {
	if (!json) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		if (typeof value !== 'string') continue;
		out[key] = value;
	}
	return out;
}

export function secretKeys(json: string | null | undefined): string[] {
	return Object.keys(parseSecretsJson(json));
}

export function parseInputSchema(json: string): object {
	try {
		const parsed = JSON.parse(json);
		// Reject arrays — an array is a JSON object by JSON spec but not by
		// JSON Schema. The Anthropic / OpenAI adapters expect an object shape.
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as object;
		}
	} catch {
		// fall through
	}
	return { type: 'object' };
}
