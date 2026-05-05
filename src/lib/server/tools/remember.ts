import type { Tool, ToolContext, ToolExecutionResult } from './registry';
import { createMemory } from '../memories';

const inputSchema = {
	type: 'object',
	properties: {
		content: {
			type: 'string',
			description:
				"A short, self-contained fact about the user worth remembering across conversations (preferences, recurring projects, biographical details, etc.). Don't restate things already in the user's bio.",
		},
	},
	required: ['content'],
} as const;

export function createRememberTool(): Tool {
	return {
		definition: {
			name: 'remember',
			description:
				'Persist a memory about the user that should be available in every future conversation. Use sparingly: only for stable facts the user explicitly asks you to remember, or that will clearly improve future replies. Memories are visible in Settings → Memories where the user can review or delete them.',
			inputSchema,
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const args = (input ?? {}) as { content?: unknown };
			const content = typeof args.content === 'string' ? args.content.trim() : '';
			if (!content) {
				return { content: 'Missing required parameter: content', isError: true, errorCode: 'invalid_input' };
			}
			try {
				const id = await createMemory(ctx.env, { type: 'auto', content, source: 'tool:remember' });
				return { content: `Saved memory #${id}: ${content}` };
			} catch (e) {
				return {
					content: e instanceof Error ? e.message : String(e),
					isError: true,
					errorCode: 'execution_failure',
				};
			}
		},
	};
}
