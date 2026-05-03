import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createGetModelsTool } from './get_models';

const ctx = { env, conversationId: 'c-1', assistantMessageId: 'a-1' };

describe('createGetModelsTool', () => {
	it('reports the current parent-agent model and the curated list', async () => {
		const tool = createGetModelsTool({
			currentModel: 'a/model-1',
			availableModels: [
				{ slug: 'a/model-1', label: 'Model One' },
				{ slug: 'b/model-2', label: 'Model Two' },
			],
		});
		const result = await tool.execute(ctx, {});
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('Current model (parent agent): a/model-1');
		expect(result.content).toContain('a/model-1 (Model One) [current]');
		expect(result.content).toContain('b/model-2 (Model Two)');
		expect(result.content).not.toMatch(/b\/model-2[^\n]*\[current\]/);
	});

	it('omits the parenthesised label when slug == label', async () => {
		const tool = createGetModelsTool({
			currentModel: 'm',
			availableModels: [{ slug: 'm', label: 'm' }],
		});
		const result = await tool.execute(ctx, {});
		expect(result.content).toContain('- m [current]');
		expect(result.content).not.toContain('(m)');
	});

	it('handles an empty model catalogue gracefully', async () => {
		const tool = createGetModelsTool({ currentModel: 'p', availableModels: [] });
		const result = await tool.execute(ctx, {});
		expect(result.content).toContain('Current model (parent agent): p');
		expect(result.content).toContain('No curated model list configured.');
	});

	it('exposes a no-input schema', () => {
		const tool = createGetModelsTool({ currentModel: 'p', availableModels: [] });
		expect(tool.definition.name).toBe('get_models');
		const schema = tool.definition.inputSchema as { type: string; properties: Record<string, unknown> };
		expect(schema.type).toBe('object');
		expect(Object.keys(schema.properties)).toHaveLength(0);
	});
});
