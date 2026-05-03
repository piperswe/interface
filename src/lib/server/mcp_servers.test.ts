import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer, deleteMcpServer, getMcpServer, listMcpServers, setMcpServerEnabled } from './mcp_servers';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM mcp_servers').run();
});

describe('mcp_servers', () => {
	it('createMcpServer returns an id and listMcpServers reads the row back', async () => {
		const id = await createMcpServer(env, { name: 'test', transport: 'http', url: 'https://x.example' });
		expect(id).toBeGreaterThan(0);
		const rows = await listMcpServers(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'test', transport: 'http', url: 'https://x.example', enabled: true });
	});

	it('listMcpServers returns rows ordered by name', async () => {
		await createMcpServer(env, { name: 'b', transport: 'http', url: 'https://b.example' });
		await createMcpServer(env, { name: 'a', transport: 'http', url: 'https://a.example' });
		const rows = await listMcpServers(env);
		expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
	});

	it('setMcpServerEnabled toggles the enabled flag', async () => {
		const id = await createMcpServer(env, { name: 'x', transport: 'http', url: 'https://x.example' });
		await setMcpServerEnabled(env, id, false);
		const [row] = await listMcpServers(env);
		expect(row.enabled).toBe(false);
	});

	it('deleteMcpServer removes the row', async () => {
		const id = await createMcpServer(env, { name: 'gone', transport: 'http', url: 'https://x.example' });
		await deleteMcpServer(env, id);
		expect(await listMcpServers(env)).toEqual([]);
	});

	it('isolates rows per user_id', async () => {
		await createMcpServer(env, { name: 'a', transport: 'http', url: 'https://a.example' }, 1);
		await createMcpServer(env, { name: 'b', transport: 'http', url: 'https://b.example' }, 2);
		expect((await listMcpServers(env, 1)).map((r) => r.name)).toEqual(['a']);
		expect((await listMcpServers(env, 2)).map((r) => r.name)).toEqual(['b']);
	});

	it('persists optional fields (auth_json, command, env_json)', async () => {
		const id = await createMcpServer(env, {
			name: 'full',
			transport: 'sse',
			url: 'https://full.example/sse',
			authJson: '{"Authorization":"Bearer abc"}',
		});
		const row = await getMcpServer(env, id);
		expect(row).toMatchObject({
			name: 'full',
			transport: 'sse',
			url: 'https://full.example/sse',
			authJson: '{"Authorization":"Bearer abc"}',
			enabled: true,
		});
	});

	it('getMcpServer returns null for unknown ids', async () => {
		expect(await getMcpServer(env, 999_999)).toBeNull();
	});

	it('deleteMcpServer is scoped by user_id', async () => {
		const id = await createMcpServer(env, { name: 'a', transport: 'http', url: 'https://a.example' }, 1);
		// Wrong user — should not delete.
		await deleteMcpServer(env, id, 2);
		expect((await listMcpServers(env, 1))).toHaveLength(1);
		// Right user — gone.
		await deleteMcpServer(env, id, 1);
		expect((await listMcpServers(env, 1))).toHaveLength(0);
	});

	it('setMcpServerEnabled is scoped by user_id', async () => {
		const id = await createMcpServer(env, { name: 'a', transport: 'http', url: 'https://a.example' }, 1);
		await setMcpServerEnabled(env, id, false, 2); // wrong user — no effect
		expect((await listMcpServers(env, 1))[0].enabled).toBe(true);
		await setMcpServerEnabled(env, id, false, 1);
		expect((await listMcpServers(env, 1))[0].enabled).toBe(false);
	});
});
