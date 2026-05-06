import { describe, expect, it, vi } from 'vitest';
import { createSwitchModelTool } from './switch_model';
import type { ToolContext } from './registry';

const baseCtx: Omit<ToolContext, 'env'> = {
	conversationId: 'c1',
	assistantMessageId: 'a1',
	modelId: 'p/m',
};
// We don't need a real Env for this tool — it never reads from `ctx.env`.
const env = {} as Env;

describe('switch_model tool', () => {
	it('exposes the documented definition shape', () => {
		const tool = createSwitchModelTool({ availableModelGlobalIds: ['anthropic/claude'] });
		expect(tool.definition.name).toBe('switch_model');
		const schema = tool.definition.inputSchema as {
			type: string;
			required: string[];
			additionalProperties: boolean;
			properties: { model_id: { type: string } };
		};
		expect(schema.type).toBe('object');
		expect(schema.required).toEqual(['model_id']);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties.model_id.type).toBe('string');
	});

	it('rejects an unknown model with errorCode invalid_input', async () => {
		const tool = createSwitchModelTool({ availableModelGlobalIds: ['openai/gpt-5.5'] });
		const switchModel = vi.fn();
		const result = await tool.execute({ ...baseCtx, env, switchModel }, { model_id: 'mystery/x' });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
		expect(result.content).toContain('Unknown model');
		expect(result.content).toContain('openai/gpt-5.5');
		expect(switchModel).not.toHaveBeenCalled();
	});

	it('returns errorCode execution_failure when ctx.switchModel is undefined', async () => {
		const tool = createSwitchModelTool({ availableModelGlobalIds: ['openai/gpt-5.5'] });
		const result = await tool.execute({ ...baseCtx, env }, { model_id: 'openai/gpt-5.5' });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('execution_failure');
		expect(result.content).toMatch(/not available/i);
	});

	it('calls ctx.switchModel and returns a confirmation on success', async () => {
		const tool = createSwitchModelTool({
			availableModelGlobalIds: ['openai/gpt-5.5', 'anthropic/claude-sonnet-4-6'],
		});
		const switchModel = vi.fn();
		const result = await tool.execute({ ...baseCtx, env, switchModel }, { model_id: 'anthropic/claude-sonnet-4-6' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('anthropic/claude-sonnet-4-6');
		expect(switchModel).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
	});

	it('an empty availableModelGlobalIds list always rejects with invalid_input', async () => {
		const tool = createSwitchModelTool({ availableModelGlobalIds: [] });
		const switchModel = vi.fn();
		const result = await tool.execute({ ...baseCtx, env, switchModel }, { model_id: 'anything' });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});
});
