import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildCustomTool, customToolNamespacedName } from './custom_tool_runner';
import type { CustomToolRow } from '../custom_tools';

function row(overrides: Partial<CustomToolRow> = {}): CustomToolRow {
	return {
		id: 1,
		name: 'echo',
		description: 'echoes input',
		source: '',
		inputSchema: '{"type":"object"}',
		secretsJson: null,
		enabled: true,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

const ctx = { env, conversationId: 'c', assistantMessageId: 'a', modelId: 'p/m' };

describe('customToolNamespacedName', () => {
	it('namespaces tool names by id and source name', () => {
		expect(customToolNamespacedName(row({ id: 7, name: 'weather' }))).toBe('custom_7_weather');
	});
});

describe('buildCustomTool definition', () => {
	it('parses input_schema JSON into the tool definition', () => {
		const tool = buildCustomTool(row({ inputSchema: '{"type":"object","properties":{"q":{"type":"string"}}}' }));
		expect(tool.definition.inputSchema).toEqual({
			type: 'object',
			properties: { q: { type: 'string' } },
		});
	});

	it('falls back to {type:"object"} when input_schema is not valid JSON', () => {
		const tool = buildCustomTool(row({ inputSchema: 'garbage' }));
		expect(tool.definition.inputSchema).toEqual({ type: 'object' });
	});

	it('uses the row description verbatim', () => {
		const tool = buildCustomTool(row({ description: 'check the weather' }));
		expect(tool.definition.description).toBe('check the weather');
	});
});

describe('buildCustomTool execute (Worker Loader)', () => {
	const SOURCE = `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class extends WorkerEntrypoint {
  async run(input) {
    return { echoed: input, key: this.env.SECRET ?? null };
  }
}`;

	it('reports a clear error when RUN_JS_LOADER is not bound', async () => {
		const tool = buildCustomTool(row({ source: SOURCE }));
		const result = await tool.execute(
			{ ...ctx, env: { ...ctx.env, RUN_JS_LOADER: undefined } as unknown as typeof ctx.env },
			{},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/RUN_JS_LOADER/);
	});

	it('passes input through to the loaded worker and JSON-stringifies the return value', async () => {
		const tool = buildCustomTool(row({ source: SOURCE }));
		const result = await tool.execute(ctx, { hello: 'world' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('"echoed"');
		expect(result.content).toContain('"hello"');
		expect(result.content).toContain('"world"');
	});

	it('passes secrets_json as the worker env', async () => {
		const tool = buildCustomTool(row({ source: SOURCE, secretsJson: '{"SECRET":"shh"}' }));
		const result = await tool.execute(ctx, { x: 1 });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('"key": "shh"');
	});

	it('reports thrown errors as tool errors', async () => {
		const tool = buildCustomTool(
			row({
				source: `import { WorkerEntrypoint } from 'cloudflare:workers';
				export default class extends WorkerEntrypoint { async run() { throw new Error('boom'); } }`,
			}),
		);
		const result = await tool.execute(ctx, {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('execution_failure');
		expect(result.content).toMatch(/boom/);
	});

	it('regression: editing source must change the cache key', async () => {
		// If two rows with different source map to the same cached worker,
		// the second invocation would still run the first version's code.
		const v1 = buildCustomTool(
			row({
				id: 42,
				source: `import { WorkerEntrypoint } from 'cloudflare:workers';
				export default class extends WorkerEntrypoint { async run() { return 'v1'; } }`,
			}),
		);
		const r1 = await v1.execute(ctx, {});
		expect(r1.content).toBe('v1');

		const v2 = buildCustomTool(
			row({
				id: 42,
				source: `import { WorkerEntrypoint } from 'cloudflare:workers';
				export default class extends WorkerEntrypoint { async run() { return 'v2'; } }`,
			}),
		);
		const r2 = await v2.execute(ctx, {});
		expect(r2.content).toBe('v2');
	});
});
