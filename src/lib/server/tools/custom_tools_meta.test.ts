import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createCustomTool, getCustomToolByName } from '../custom_tools';
import { createCustomToolTool, getCustomToolTool, listCustomToolsTool, updateCustomToolTool } from './custom_tools_meta';

const STUB_SOURCE = `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class extends WorkerEntrypoint { async run(){ return 1; } }`;

const ctx = { assistantMessageId: 'a', conversationId: 'c', env, modelId: 'p/m' };

afterEach(async () => {
	await env.DB.prepare('DELETE FROM custom_tools').run();
});

describe('list_custom_tools', () => {
	it('reports an empty list', async () => {
		const result = await listCustomToolsTool.execute(ctx, {});
		expect(result.content).toMatch(/No custom tools/);
	});

	it('lists tools (id, name, description, enabled)', async () => {
		await createCustomTool(env, {
			description: 'gets weather',
			inputSchema: '{"type":"object"}',
			name: 'weather',
			source: STUB_SOURCE,
		});
		const result = await listCustomToolsTool.execute(ctx, {});
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(String(result.content));
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ description: 'gets weather', enabled: true, name: 'weather' });
	});
});

describe('get_custom_tool', () => {
	it('rejects when neither id nor name is provided', async () => {
		const result = await getCustomToolTool.execute(ctx, {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	it('reports not_found for unknown id', async () => {
		const result = await getCustomToolTool.execute(ctx, { id: 9_999_999 });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('not_found');
	});

	it('redacts secret values, returning only the keys', async () => {
		await createCustomTool(env, {
			description: 'd',
			inputSchema: '{"type":"object"}',
			name: 'weather',
			secretsJson: '{"OWM_KEY":"hunter2","BACKUP_KEY":"hunter3"}',
			source: STUB_SOURCE,
		});
		const result = await getCustomToolTool.execute(ctx, { name: 'weather' });
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(String(result.content));
		expect(parsed.secret_keys).toEqual(['OWM_KEY', 'BACKUP_KEY']);
		expect(JSON.stringify(parsed)).not.toContain('hunter2');
		expect(JSON.stringify(parsed)).not.toContain('hunter3');
	});
});

describe('create_custom_tool', () => {
	it('creates a tool with the given fields', async () => {
		const result = await createCustomToolTool.execute(ctx, {
			description: 'gets weather',
			input_schema: { properties: { city: { type: 'string' } }, type: 'object' },
			name: 'weather',
			secrets: { OWM_KEY: 'abc' },
			source: STUB_SOURCE,
		});
		expect(result.isError).toBeFalsy();
		const row = await getCustomToolByName(env, 'weather');
		expect(row).not.toBeNull();
		expect(row?.description).toBe('gets weather');
		expect(row?.secretsJson).toBe('{"OWM_KEY":"abc"}');
	});

	it('rejects invalid names', async () => {
		const result = await createCustomToolTool.execute(ctx, {
			description: 'd',
			input_schema: { type: 'object' },
			name: 'mcp_taken',
			source: STUB_SOURCE,
		});
		expect(result.isError).toBe(true);
	});

	it('rejects missing required fields', async () => {
		const result = await createCustomToolTool.execute(ctx, { name: 'weather' });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	it('accepts input_schema as a string (already JSON)', async () => {
		const result = await createCustomToolTool.execute(ctx, {
			description: 'd',
			input_schema: '{"type":"object"}',
			name: 'a',
			source: STUB_SOURCE,
		});
		expect(result.isError).toBeFalsy();
	});
});

describe('update_custom_tool', () => {
	it('patches partial fields', async () => {
		const id = await createCustomTool(env, {
			description: 'old',
			inputSchema: '{"type":"object"}',
			name: 'foo',
			source: STUB_SOURCE,
		});
		const result = await updateCustomToolTool.execute(ctx, { description: 'new', id });
		expect(result.isError).toBeFalsy();
		const row = await getCustomToolByName(env, 'foo');
		expect(row?.description).toBe('new');
	});

	it('rejects without an id', async () => {
		const result = await updateCustomToolTool.execute(ctx, { description: 'oops' });
		expect(result.isError).toBe(true);
	});

	it('clears secrets when an empty object is passed', async () => {
		const id = await createCustomTool(env, {
			description: 'd',
			inputSchema: '{"type":"object"}',
			name: 'foo',
			secretsJson: '{"X":"y"}',
			source: STUB_SOURCE,
		});
		const result = await updateCustomToolTool.execute(ctx, { id, secrets: {} });
		expect(result.isError).toBeFalsy();
		const row = await getCustomToolByName(env, 'foo');
		expect(row?.secretsJson).toBe('{}');
	});
});
