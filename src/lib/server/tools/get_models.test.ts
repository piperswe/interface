import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createGetModelsTool } from './get_models';

const ctx = { assistantMessageId: 'a-1', conversationId: 'c-1', env, modelId: 'p/m' };

describe('createGetModelsTool', () => {
	it('reports the current parent-agent model and the configured models', async () => {
		const tool = createGetModelsTool({
			availableModels: [
				{
					createdAt: 0,
					description: null,
					id: 'anthropic/claude-sonnet-4',
					inputCostPerMillionTokens: null,
					maxContextLength: 200_000,
					name: 'Claude Sonnet 4',
					outputCostPerMillionTokens: null,
					providerId: 'openrouter',
					reasoningType: 'max_tokens',
					sortOrder: 0,
					supportsImageInput: false,
					updatedAt: 0,
				},
				{
					createdAt: 0,
					description: null,
					id: 'openai/gpt-5.5',
					inputCostPerMillionTokens: null,
					maxContextLength: 128_000,
					name: 'GPT-5.5',
					outputCostPerMillionTokens: null,
					providerId: 'openrouter',
					reasoningType: 'effort',
					sortOrder: 0,
					supportsImageInput: false,
					updatedAt: 0,
				},
			],
			currentModel: 'openrouter/anthropic/claude-sonnet-4',
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
			availableModels: [
				{
					createdAt: 0,
					description: null,
					id: 'm',
					inputCostPerMillionTokens: null,
					maxContextLength: 128_000,
					name: 'm',
					outputCostPerMillionTokens: null,
					providerId: 'p',
					reasoningType: null,
					sortOrder: 0,
					supportsImageInput: false,
					updatedAt: 0,
				},
			],
			currentModel: 'p/m',
		});
		const result = await tool.execute(ctx, {});
		expect(result.content).toContain('- p/m [current]');
		expect(result.content).not.toContain('(m)');
	});

	it('handles an empty model catalogue gracefully', async () => {
		const tool = createGetModelsTool({ availableModels: [], currentModel: 'p' });
		const result = await tool.execute(ctx, {});
		expect(result.content).toContain('Current model (parent agent): p');
		expect(result.content).toContain('No models configured.');
	});

	it('exposes a no-input schema', () => {
		const tool = createGetModelsTool({ availableModels: [], currentModel: 'p' });
		expect(tool.definition.name).toBe('get_models');
		const schema = tool.definition.inputSchema as { type: string; properties: Record<string, unknown> };
		expect(schema.type).toBe('object');
		expect(Object.keys(schema.properties)).toHaveLength(0);
	});
});
