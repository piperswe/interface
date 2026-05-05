import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createStyle, deleteStyle, getStyle, listStyles, updateStyle } from './styles';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM styles').run();
	await env.DB.prepare('UPDATE conversations SET style_id = NULL').run();
});

describe('styles', () => {
	it('round-trips through create + list + get', async () => {
		const id = await createStyle(env, { name: 'Concise', systemPrompt: 'Be brief.' });
		expect(id).toBeGreaterThan(0);
		const rows = await listStyles(env);
		expect(rows).toMatchObject([{ name: 'Concise', systemPrompt: 'Be brief.' }]);
		const one = await getStyle(env, id);
		expect(one?.name).toBe('Concise');
	});

	it('updateStyle changes name + system prompt', async () => {
		const id = await createStyle(env, { name: 'Concise', systemPrompt: 'Be brief.' });
		await updateStyle(env, id, { name: 'Terse', systemPrompt: 'Single sentence answers.' });
		const after = await getStyle(env, id);
		expect(after).toMatchObject({ name: 'Terse', systemPrompt: 'Single sentence answers.' });
	});

	it('rejects empty name or system prompt', async () => {
		await expect(createStyle(env, { name: '   ', systemPrompt: 'x' })).rejects.toThrow(/Name/);
		await expect(createStyle(env, { name: 'x', systemPrompt: '   ' })).rejects.toThrow(/System prompt/);
	});

	it('deleteStyle clears style_id from conversations referencing it', async () => {
		const styleId = await createStyle(env, { name: 'X', systemPrompt: 'p' });
		await env.DB.prepare(
			"INSERT INTO conversations (id, title, created_at, updated_at, style_id) VALUES (?, 'c', 1, 1, ?)",
		)
			.bind('test-conv', styleId)
			.run();
		await deleteStyle(env, styleId);
		const row = await env.DB.prepare('SELECT style_id FROM conversations WHERE id = ?')
			.bind('test-conv')
			.first<{ style_id: number | null }>();
		expect(row?.style_id).toBeNull();
		await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind('test-conv').run();
	});
});
