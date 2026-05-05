import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createRememberTool } from './remember';
import { listMemories } from '../memories';
import type { ToolContext } from './registry';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM memories').run();
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		env,
		conversationId: 'conv-id',
		assistantMessageId: 'asst-id',
		...overrides,
	};
}

describe('remember tool', () => {
	it('definition has the expected name + schema', () => {
		const t = createRememberTool();
		expect(t.definition.name).toBe('remember');
		expect(t.definition.inputSchema).toMatchObject({
			type: 'object',
			required: ['content'],
		});
	});

	it('execute persists a memory with type=auto, source=tool:remember', async () => {
		const t = createRememberTool();
		const result = await t.execute(makeCtx(), { content: '  My dog is named Pepper.  ' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toMatch(/Saved memory/);
		const rows = await listMemories(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			content: 'My dog is named Pepper.',
			type: 'auto',
			source: 'tool:remember',
		});
	});

	it('rejects empty content with invalid_input error code', async () => {
		const t = createRememberTool();
		const result = await t.execute(makeCtx(), { content: '   ' });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	it('rejects missing content with invalid_input', async () => {
		const t = createRememberTool();
		const result = await t.execute(makeCtx(), {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	it('rejects non-string content', async () => {
		const t = createRememberTool();
		const result = await t.execute(makeCtx(), { content: 42 });
		expect(result.isError).toBe(true);
	});
});
