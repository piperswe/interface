import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createGetModelsTool } from './get_models';

const ctx = { env, conversationId: 'c-1', assistantMessageId: 'a-1' };

describe('createGetModelsTool', () => {
	it('reports the current parent-agent model and the configured models', async () => {
		const tool = createGetModelsTool({
			currentModel: 'openrouter/anthropic/claude-sonnet-4',
			availableModels: [
				{ id: 'anthropic/claude-sonnet-4', providerId: 'openrouter', name: 'Claude Sonnet 4', createdAt: 0, updatedAt: 0, maxContextLength: 200_000, description: null, reasoningType: 'max_tokens', inputCostPerMillionTokens: null, outputCostPerMillionTokens: null, sortOrder: 0 },
				{ id: 'openai/gpt-5.5', providerId: 'openrouter', name: 'GPT-5.5', createdAt: 0, updatedAt: 0, maxContextLength: 128_000, description: null, reasoningType: 'effort', inputCostPerMillionTokens: null, outputCostPerMillionTokens: null, sortOrder: 0 },
			],
		});
		const result = await tool.execute(ctx, {});
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('Current model (parent agent): openrouter/anthropic/claude-sonnet-4');
		expect(result.content).toContain('openrouter/anthropic/claude-sonnet-4 (Claude Sonnet 4) [current]');
		expect(result.content).toContain('openrouter/openai/gpt-5.5 (GPT-5.5)');
		expect(result.content).not.toMatch(/openrouter\/openai\/gpt-5\.5[^\n]*\[current\]/);
	});

	it('omits the parenthesised label when id == name', async () => {
		const tool = createGetModelsTool({
			currentModel: 'p/m',
			availableModels: [{ id: 'm', providerId: 'p', name: 'm', createdAt: 0, updatedAt: 0, maxContextLength: 128_000, description: null, reasoningType: null, inputCostPerMillionTokens: null, outputCostPerMillionTokens: null, sortOrder: 0 }],
		});
		const result = await tool.execute(ctx, {});
		expect(result.content).toContain('- p/m [current]');
		expect(result.content).not.toContain('(m)');
	});

	it('handles an empty model catalogue gracefully', async () => {
		const tool = createGetModelsTool({ currentModel: 'p', availableModels: [] });
		const result = await tool.execute(ctx, {});
		expect(result.content).toContain('Current model (parent agent): p');
		expect(result.content).toContain('No models configured.');
	});

	it('exposes a no-input schema', () => {
		const tool = createGetModelsTool({ currentModel: 'p', availableModels: [] });
		expect(tool.definition.name).toBe('get_models');
		const schema = tool.definition.inputSchema as { type: string; properties: Record<string, unknown> };
		expect(schema.type).toBe('object');
		expect(Object.keys(schema.properties)).toHaveLength(0);
	});
});
