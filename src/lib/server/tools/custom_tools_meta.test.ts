import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createCustomToolTool,
	getCustomToolTool,
	listCustomToolsTool,
	updateCustomToolTool,
} from './custom_tools_meta';
import { createCustomTool, getCustomToolByName } from '../custom_tools';

const STUB_SOURCE = `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class extends WorkerEntrypoint { async run(){ return 1; } }`;

const ctx = { env, conversationId: 'c', assistantMessageId: 'a', modelId: 'p/m' };

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
			name: 'weather',
			description: 'gets weather',
			source: STUB_SOURCE,
			inputSchema: '{"type":"object"}',
		});
		const result = await listCustomToolsTool.execute(ctx, {});
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(String(result.content));
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ name: 'weather', description: 'gets weather', enabled: true });
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
			name: 'weather',
			description: 'd',
			source: STUB_SOURCE,
			inputSchema: '{"type":"object"}',
			secretsJson: '{"OWM_KEY":"hunter2","BACKUP_KEY":"hunter3"}',
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
			name: 'weather',
			description: 'gets weather',
			source: STUB_SOURCE,
			input_schema: { type: 'object', properties: { city: { type: 'string' } } },
			secrets: { OWM_KEY: 'abc' },
		});
		expect(result.isError).toBeFalsy();
		const row = await getCustomToolByName(env, 'weather');
		expect(row).not.toBeNull();
		expect(row?.description).toBe('gets weather');
		expect(row?.secretsJson).toBe('{"OWM_KEY":"abc"}');
	});

	it('rejects invalid names', async () => {
		const result = await createCustomToolTool.execute(ctx, {
			name: 'mcp_taken',
			description: 'd',
			source: STUB_SOURCE,
			input_schema: { type: 'object' },
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
			name: 'a',
			description: 'd',
			source: STUB_SOURCE,
			input_schema: '{"type":"object"}',
		});
		expect(result.isError).toBeFalsy();
	});
});

describe('update_custom_tool', () => {
	it('patches partial fields', async () => {
		const id = await createCustomTool(env, {
			name: 'foo',
			description: 'old',
			source: STUB_SOURCE,
			inputSchema: '{"type":"object"}',
		});
		const result = await updateCustomToolTool.execute(ctx, { id, description: 'new' });
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
			name: 'foo',
			description: 'd',
			source: STUB_SOURCE,
			inputSchema: '{"type":"object"}',
			secretsJson: '{"X":"y"}',
		});
		const result = await updateCustomToolTool.execute(ctx, { id, secrets: {} });
		expect(result.isError).toBeFalsy();
		const row = await getCustomToolByName(env, 'foo');
		expect(row?.secretsJson).toBe('{}');
	});
});
