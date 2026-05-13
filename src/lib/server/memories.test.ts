import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemory, deleteMemory, listMemories } from './memories';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM memories').run();
});

describe('memories', () => {
	it('createMemory inserts a row and listMemories returns it', async () => {
		const id = await createMemory(env, {
			content: 'I prefer terse responses.',
			source: 'user',
			type: 'manual',
		});
		expect(id).toBeGreaterThan(0);
		const rows = await listMemories(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			content: 'I prefer terse responses.',
			source: 'user',
			type: 'manual',
		});
	});

	it('rejects empty content', async () => {
		await expect(createMemory(env, { content: '   ', source: 'user', type: 'manual' })).rejects.toThrow(/required/);
	});

	it('orders by created_at DESC', async () => {
		const a = await createMemory(env, { content: 'first', source: 'user', type: 'manual' });
		// Force a different timestamp for deterministic ordering
		await new Promise((r) => setTimeout(r, 5));
		const b = await createMemory(env, { content: 'second', source: 'tool:remember', type: 'auto' });
		const rows = await listMemories(env);
		expect(rows.map((r) => r.id)).toEqual([b, a]);
	});

	it('deleteMemory removes the row', async () => {
		const id = await createMemory(env, { content: 'gone', source: 'user', type: 'manual' });
		await deleteMemory(env, id);
		expect(await listMemories(env)).toHaveLength(0);
	});
});
