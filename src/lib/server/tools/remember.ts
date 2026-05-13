import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import { createMemory } from '../memories';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

// Cap each memory at 1 KiB. Each memory is splatted into every future
// conversation's system prompt, so a 10 KB attacker-supplied memory would
// add 10 KB to every request indefinitely (and the LLM would see attacker
// text in the system role — persistent prompt-injection).
const MAX_MEMORY_CONTENT_LEN = 1024;

const inputArgsSchema = z.object({
	content: z.string().max(MAX_MEMORY_CONTENT_LEN, {
		message: `content exceeds ${MAX_MEMORY_CONTENT_LEN} characters`,
	}),
});

const inputSchema = {
	properties: {
		content: {
			description:
				"A short, self-contained fact about the user worth remembering across conversations (preferences, recurring projects, biographical details, etc.). Don't restate things already in the user's bio.",
			type: 'string',
		},
	},
	required: ['content'],
	type: 'object',
} as const;

export function createRememberTool(): Tool {
	return {
		definition: {
			description:
				'Persist a memory about the user that should be available in every future conversation. Use sparingly: only for stable facts the user explicitly asks you to remember, or that will clearly improve future replies. Memories are visible in Settings → Memories where the user can review or delete them.',
			inputSchema,
			name: 'remember',
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(inputArgsSchema, input);
			if (!parsed.ok) {
				return { content: `Invalid input: ${parsed.error}`, errorCode: 'invalid_input', isError: true };
			}
			const content = parsed.value.content.trim();
			if (!content) {
				return { content: 'Missing required parameter: content', errorCode: 'invalid_input', isError: true };
			}
			try {
				const id = await createMemory(ctx.env, { content, source: 'tool:remember', type: 'auto' });
				return { content: `Saved memory #${id}: ${content}` };
			} catch (e) {
				return {
					content: e instanceof Error ? e.message : String(e),
					errorCode: 'execution_failure',
					isError: true,
				};
			}
		},
	};
}
