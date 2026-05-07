import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import type { Tool, ToolExecutionResult } from './registry';

export type SwitchModelToolDeps = {
	availableModelGlobalIds: string[];
};

const inputSchema = z.object({ model_id: z.string() });

export function createSwitchModelTool(deps: SwitchModelToolDeps): Tool {
	return {
		definition: {
			name: 'switch_model',
			description:
				'Switch the model used for subsequent LLM responses in this conversation turn. The new model takes effect on the next response after this tool call completes. Call `get_models` first to see available model IDs.',
			inputSchema: {
				type: 'object',
				properties: {
					model_id: {
						type: 'string',
						description: 'Global model ID to switch to (e.g. "anthropic/claude-opus-4-7").',
					},
				},
				required: ['model_id'],
				additionalProperties: false,
			},
		},
		async execute(ctx, input): Promise<ToolExecutionResult> {
			const parsed = safeValidate(inputSchema, input);
			if (!parsed.ok) {
				return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
			}
			const { model_id } = parsed.value;
			if (!deps.availableModelGlobalIds.includes(model_id)) {
				return {
					content: `Unknown model: ${model_id}. Available: ${deps.availableModelGlobalIds.join(', ')}`,
					isError: true,
					errorCode: 'invalid_input',
				};
			}
			if (!ctx.switchModel) {
				return {
					content: 'Model switching is not available in this context.',
					isError: true,
					errorCode: 'execution_failure',
				};
			}
			ctx.switchModel(model_id);
			return { content: `Switched to ${model_id}. The next response will use this model.` };
		},
	};
}
