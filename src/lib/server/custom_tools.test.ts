import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createCustomTool,
	customToolNameError,
	deleteCustomTool,
	getCustomTool,
	getCustomToolByName,
	isValidCustomToolName,
	listCustomTools,
	parseSecretsJson,
	secretKeys,
	setCustomToolEnabled,
	updateCustomTool,
} from './custom_tools';

const STUB_SOURCE = `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class extends WorkerEntrypoint { async run(){ return 1; } }`;
const STUB_SCHEMA = '{"type":"object"}';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM custom_tools').run();
});

describe('isValidCustomToolName', () => {
	it('accepts snake_case names starting with a letter', () => {
		expect(isValidCustomToolName('weather')).toBe(true);
		expect(isValidCustomToolName('current_weather_v2')).toBe(true);
	});

	it('rejects names that start with a digit, dash, or underscore', () => {
		expect(isValidCustomToolName('1weather')).toBe(false);
		expect(isValidCustomToolName('_weather')).toBe(false);
		expect(isValidCustomToolName('-weather')).toBe(false);
	});

	it('rejects names colliding with built-in tools', () => {
		expect(isValidCustomToolName('fetch_url')).toBe(false);
		expect(isValidCustomToolName('run_js')).toBe(false);
		expect(isValidCustomToolName('agent')).toBe(false);
	});

	it('rejects reserved prefixes', () => {
		expect(isValidCustomToolName('mcp_anything')).toBe(false);
		expect(isValidCustomToolName('custom_anything')).toBe(false);
	});

	it('returns a descriptive error message for invalid names', () => {
		expect(customToolNameError('1bad')).toMatch(/start with a letter/);
		expect(customToolNameError('agent')).toMatch(/built-in tool/);
		expect(customToolNameError('mcp_x')).toMatch(/reserved/);
		expect(customToolNameError('ok_name')).toBeNull();
	});
});

describe('custom_tools CRUD', () => {
	it('createCustomTool round-trips through listCustomTools', async () => {
		const id = await createCustomTool(env, {
			description: 'gets weather',
			inputSchema: STUB_SCHEMA,
			name: 'weather',
			secretsJson: '{"OWM_KEY":"abc"}',
			source: STUB_SOURCE,
		});
		expect(id).toBeGreaterThan(0);
		const rows = await listCustomTools(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			description: 'gets weather',
			enabled: true,
			id,
			inputSchema: STUB_SCHEMA,
			name: 'weather',
			secretsJson: '{"OWM_KEY":"abc"}',
			source: STUB_SOURCE,
		});
	});

	it('listCustomTools returns rows ordered by name', async () => {
		await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'b', source: STUB_SOURCE });
		await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'a', source: STUB_SOURCE });
		const rows = await listCustomTools(env);
		expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
	});

	it('getCustomToolByName finds the row', async () => {
		const id = await createCustomTool(env, {
			description: 'd',
			inputSchema: STUB_SCHEMA,
			name: 'weather',
			source: STUB_SOURCE,
		});
		const row = await getCustomToolByName(env, 'weather');
		expect(row?.id).toBe(id);
	});

	it('rejects an invalid name on create', async () => {
		await expect(
			createCustomTool(env, {
				description: 'd',
				inputSchema: STUB_SCHEMA,
				name: 'mcp_taken',
				source: STUB_SOURCE,
			}),
		).rejects.toThrow(/reserved/);
	});

	it('rejects a duplicate name on create', async () => {
		await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'dup', source: STUB_SOURCE });
		await expect(createCustomTool(env, { description: 'd2', inputSchema: STUB_SCHEMA, name: 'dup', source: STUB_SOURCE })).rejects.toThrow(
			/already exists/,
		);
	});

	it('rejects invalid JSON in input_schema', async () => {
		await expect(
			createCustomTool(env, {
				description: 'd',
				inputSchema: 'not-json',
				name: 'badschema',
				source: STUB_SOURCE,
			}),
		).rejects.toThrow(/input_schema/);
	});

	it('rejects invalid JSON in secrets_json', async () => {
		await expect(
			createCustomTool(env, {
				description: 'd',
				inputSchema: STUB_SCHEMA,
				name: 'badsec',
				secretsJson: 'not-json',
				source: STUB_SOURCE,
			}),
		).rejects.toThrow(/secrets_json/);
	});

	// Regression (F1): secrets values were not validated to be strings, so the
	// LLM could pass `{KEY: {prototype: ...}}` and the non-string value would
	// land in the loaded worker's env. Reject non-string values.
	it('rejects non-string values in secrets_json', async () => {
		await expect(
			createCustomTool(env, {
				description: 'd',
				inputSchema: STUB_SCHEMA,
				name: 'badsec2',
				secretsJson: '{"KEY": 123}',
				source: STUB_SOURCE,
			}),
		).rejects.toThrow(/must be a string/);
	});

	// Regression (F1 / F7): keys like `__proto__` survive JSON.parse and would
	// reach the loaded worker's env. Reject them upstream.
	it('rejects forbidden keys (__proto__, constructor, prototype) in secrets_json', async () => {
		await expect(
			createCustomTool(env, {
				description: 'd',
				inputSchema: STUB_SCHEMA,
				name: 'badsec3',
				secretsJson: '{"__proto__":"x"}',
				source: STUB_SOURCE,
			}),
		).rejects.toThrow(/forbidden key/);
	});

	// Regression (F4): no length cap on description meant the LLM could
	// silently inflate the system prompt by self-authoring a tool with a
	// gigantic description.
	it('rejects descriptions longer than the cap', async () => {
		await expect(
			createCustomTool(env, {
				description: 'x'.repeat(2000),
				inputSchema: STUB_SCHEMA,
				name: 'longdesc',
				source: STUB_SOURCE,
			}),
		).rejects.toThrow(/maximum length/);
	});

	// Regression (F8): parseInputSchema used to accept arrays as schemas,
	// which the LLM adapters then forwarded as `input_schema` (expecting an
	// object shape).
	it('rejects arrays in input_schema', async () => {
		await expect(
			createCustomTool(env, {
				description: 'd',
				inputSchema: '[]',
				name: 'arrschema',
				source: STUB_SOURCE,
			}),
		).rejects.toThrow(/must be a JSON object/);
	});

	it('updateCustomTool patches partial fields', async () => {
		const id = await createCustomTool(env, {
			description: 'old',
			inputSchema: STUB_SCHEMA,
			name: 'foo',
			source: STUB_SOURCE,
		});
		await updateCustomTool(env, id, { description: 'new' });
		const row = await getCustomTool(env, id);
		expect(row?.description).toBe('new');
		expect(row?.name).toBe('foo'); // unchanged
	});

	it('updateCustomTool rejects renaming to an existing name', async () => {
		await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'a', source: STUB_SOURCE });
		const id2 = await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'b', source: STUB_SOURCE });
		await expect(updateCustomTool(env, id2, { name: 'a' })).rejects.toThrow(/already exists/);
	});

	it('updateCustomTool can rename to the same name (no-op)', async () => {
		const id = await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'same', source: STUB_SOURCE });
		await updateCustomTool(env, id, { name: 'same' });
		expect((await getCustomTool(env, id))?.name).toBe('same');
	});

	it('setCustomToolEnabled toggles the enabled flag', async () => {
		const id = await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'x', source: STUB_SOURCE });
		await setCustomToolEnabled(env, id, false);
		expect((await getCustomTool(env, id))?.enabled).toBe(false);
		await setCustomToolEnabled(env, id, true);
		expect((await getCustomTool(env, id))?.enabled).toBe(true);
	});

	it('deleteCustomTool removes the row', async () => {
		const id = await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'gone', source: STUB_SOURCE });
		await deleteCustomTool(env, id);
		expect(await getCustomTool(env, id)).toBeNull();
	});

	it('isolates rows per user_id', async () => {
		await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'a', source: STUB_SOURCE }, 1);
		await createCustomTool(env, { description: 'd', inputSchema: STUB_SCHEMA, name: 'a', source: STUB_SOURCE }, 2);
		expect((await listCustomTools(env, 1)).map((r) => r.name)).toEqual(['a']);
		expect((await listCustomTools(env, 2)).map((r) => r.name)).toEqual(['a']);
	});
});

describe('parseSecretsJson / secretKeys', () => {
	it('returns the parsed object for a valid JSON object', () => {
		expect(parseSecretsJson('{"A":"1","B":"2"}')).toEqual({ A: '1', B: '2' });
		expect(secretKeys('{"A":"1","B":"2"}')).toEqual(['A', 'B']);
	});

	it('returns {} for null, malformed JSON, or non-object JSON', () => {
		expect(parseSecretsJson(null)).toEqual({});
		expect(parseSecretsJson('not-json')).toEqual({});
		expect(parseSecretsJson('[1,2]')).toEqual({});
		expect(secretKeys(null)).toEqual([]);
	});

	// Regression (F7): legacy rows might still have __proto__ in their stored
	// JSON. The runtime parser must drop it defensively so it never reaches
	// the loaded worker's env, and never appears in `secretKeys()` output.
	it('drops __proto__, constructor, prototype keys', () => {
		expect(parseSecretsJson('{"__proto__":"x","KEY":"v"}')).toEqual({ KEY: 'v' });
		expect(parseSecretsJson('{"constructor":"x","KEY":"v"}')).toEqual({ KEY: 'v' });
		expect(parseSecretsJson('{"prototype":"x","KEY":"v"}')).toEqual({ KEY: 'v' });
		expect(secretKeys('{"__proto__":"x","KEY":"v"}')).toEqual(['KEY']);
	});

	it('drops non-string values', () => {
		expect(parseSecretsJson('{"KEY":"v","BAD":123}')).toEqual({ KEY: 'v' });
		expect(parseSecretsJson('{"KEY":"v","BAD":{"nested":1}}')).toEqual({ KEY: 'v' });
	});
});
