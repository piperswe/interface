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

	it('returns an error result for unknown tools with errorCode=not_found', async () => {
		const registry = new ToolRegistry();
		const result = await registry.execute(ctx, 'nope', {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('not_found');
		expect(result.content).toMatch(/Unknown tool: nope/);
	});

	it('catches execute() throws and surfaces them with errorCode=execution_failure', async () => {
		const registry = new ToolRegistry().register(throwingTool);
		const result = await registry.execute(ctx, 'boom', {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('execution_failure');
		expect(result.content).toBe('boom');
	});

	it('preserves errorCodes returned by the tool itself (does not overwrite)', async () => {
		const validatorTool: Tool = {
			definition: { name: 'validator', description: '', inputSchema: { type: 'object' } },
			async execute() {
				return { content: 'bad input', isError: true, errorCode: 'invalid_input' as const };
			},
		};
		const registry = new ToolRegistry().register(validatorTool);
		const result = await registry.execute(ctx, 'validator', {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	it('passes the same context object through to the tool execute()', async () => {
		const seen: unknown[] = [];
		const peek: Tool = {
			definition: { name: 'peek', description: '', inputSchema: { type: 'object' } },
			async execute(c) {
				seen.push(c);
				return { content: 'ok' };
			},
		};
		const registry = new ToolRegistry().register(peek);
		await registry.execute(ctx, 'peek', { x: 1 });
		expect(seen[0]).toBe(ctx);
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

	it('register() overwrites a previously-registered tool with the same name', () => {
		const replacement: Tool = {
			definition: { name: 'echo', description: 'replacement', inputSchema: { type: 'object' } },
			async execute() {
				return { content: 'replaced' };
			},
		};
		const registry = new ToolRegistry().register(echoTool).register(replacement);
		expect(registry.get('echo')).toBe(replacement);
		expect(registry.definitions()).toHaveLength(1);
	});

	it('has() and get() report misses cleanly', () => {
		const registry = new ToolRegistry();
		expect(registry.has('nothing')).toBe(false);
		expect(registry.get('nothing')).toBeUndefined();
	});

	it('definitions() reflects registration order', () => {
		const registry = new ToolRegistry().register(throwingTool).register(echoTool);
		expect(registry.definitions().map((d) => d.name)).toEqual(['boom', 'echo']);
	});

	it('passes the input verbatim to the tool execute()', async () => {
		const seenInput: unknown[] = [];
		const seer: Tool = {
			definition: { name: 'seer', description: '', inputSchema: { type: 'object' } },
			async execute(_ctx, input) {
				seenInput.push(input);
				return { content: 'ok' };
			},
		};
		const registry = new ToolRegistry().register(seer);
		const payload = { a: 1, nested: { b: [1, 2] } };
		await registry.execute(ctx, 'seer', payload);
		expect(seenInput[0]).toEqual(payload);
	});
});
