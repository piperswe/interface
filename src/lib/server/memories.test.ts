import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemory, deleteMemory, listMemories } from './memories';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM memories').run();
});

describe('memories', () => {
	it('createMemory inserts a row and listMemories returns it', async () => {
		const id = await createMemory(env, {
			type: 'manual',
			content: 'I prefer terse responses.',
			source: 'user',
		});
		expect(id).toBeGreaterThan(0);
		const rows = await listMemories(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			content: 'I prefer terse responses.',
			type: 'manual',
			source: 'user',
		});
	});

	it('rejects empty content', async () => {
		await expect(createMemory(env, { type: 'manual', content: '   ', source: 'user' })).rejects.toThrow(
			/required/,
		);
	});

	it('orders by created_at DESC', async () => {
		const a = await createMemory(env, { type: 'manual', content: 'first', source: 'user' });
		// Force a different timestamp for deterministic ordering
		await new Promise((r) => setTimeout(r, 5));
		const b = await createMemory(env, { type: 'auto', content: 'second', source: 'tool:remember' });
		const rows = await listMemories(env);
		expect(rows.map((r) => r.id)).toEqual([b, a]);
	});

	it('deleteMemory removes the row', async () => {
		const id = await createMemory(env, { type: 'manual', content: 'gone', source: 'user' });
		await deleteMemory(env, id);
		expect(await listMemories(env)).toHaveLength(0);
	});
});
