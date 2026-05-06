import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type Tool } from './registry';

const echoTool: Tool = {
	definition: {
		name: 'echo',
		description: 'echoes input.text',
		inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	},
	async execute(_ctx, input) {
		const args = input as { text?: string };
		return { content: args.text ?? '' };
	},
};

const throwingTool: Tool = {
	definition: { name: 'boom', description: 'throws', inputSchema: { type: 'object' } },
	async execute() {
		throw new Error('boom');
	},
};

describe('ToolRegistry', () => {
	const ctx = { env, conversationId: 'c', assistantMessageId: 'a', modelId: 'p/m' };

	it('registers and executes a tool', async () => {
		const registry = new ToolRegistry().register(echoTool);
		expect(registry.has('echo')).toBe(true);
		expect(registry.get('echo')).toBe(echoTool);
		const result = await registry.execute(ctx, 'echo', { text: 'hi' });
		expect(result).toEqual({ content: 'hi' });
	});

	it('returns an error result for unknown tools', async () => {
		const registry = new ToolRegistry();
		const result = await registry.execute(ctx, 'nope', {});
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/Unknown tool/);
	});

	it('catches execute() throws and surfaces them as error results', async () => {
		const registry = new ToolRegistry().register(throwingTool);
		const result = await registry.execute(ctx, 'boom', {});
		expect(result.isError).toBe(true);
		expect(result.content).toBe('boom');
	});

	it('definitions() lists all registered definitions', () => {
		const registry = new ToolRegistry().register(echoTool).register(throwingTool);
		const names = registry.definitions().map((d) => d.name);
		expect(names.sort()).toEqual(['boom', 'echo']);
	});

	it('serialises non-Error throw values when execute() throws', async () => {
		const oddThrow: Tool = {
			definition: { name: 'odd', description: '', inputSchema: { type: 'object' } },
			async execute() {
				throw 'string-thrown';
			},
		};
		const registry = new ToolRegistry().register(oddThrow);
		const result = await registry.execute(ctx, 'odd', {});
		expect(result.isError).toBe(true);
		expect(result.content).toBe('string-thrown');
	});

	it('register() returns the registry for chaining', () => {
		const registry = new ToolRegistry();
		expect(registry.register(echoTool)).toBe(registry);
	});
});
