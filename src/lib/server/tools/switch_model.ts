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
			description:
				'Switch the model used for subsequent LLM responses in this conversation turn. The new model takes effect on the next response after this tool call completes. Call `get_models` first to see available model IDs.',
			inputSchema: {
				additionalProperties: false,
				properties: {
					model_id: {
						description: 'Global model ID to switch to (e.g. "anthropic/claude-opus-4-7").',
						type: 'string',
					},
				},
				required: ['model_id'],
				type: 'object',
			},
			name: 'switch_model',
		},
		async execute(ctx, input): Promise<ToolExecutionResult> {
			const parsed = safeValidate(inputSchema, input);
			if (!parsed.ok) {
				return { content: `Invalid input: ${parsed.error}`, errorCode: 'invalid_input', isError: true };
			}
			const { model_id } = parsed.value;
			if (!deps.availableModelGlobalIds.includes(model_id)) {
				return {
					content: `Unknown model: ${model_id}. Available: ${deps.availableModelGlobalIds.join(', ')}`,
					errorCode: 'invalid_input',
					isError: true,
				};
			}
			if (!ctx.switchModel) {
				return {
					content: 'Model switching is not available in this context.',
					errorCode: 'execution_failure',
					isError: true,
				};
			}
			ctx.switchModel(model_id);
			return { content: `Switched to ${model_id}. The next response will use this model.` };
		},
	};
}
