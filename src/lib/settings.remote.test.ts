import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import { type AnyArgs, expectError, expectRedirect, runForm } from '../../test/helpers';
import * as remote from './settings.remote';
import { getSetting } from './server/settings';
import { listMcpServers, setMcpServerOauthClient, setMcpServerOauthTokens } from './server/mcp_servers';
import { listMemories } from './server/memories';
import { listStyles, getStyle } from './server/styles';

const saveSetting = remote.saveSetting as unknown as AnyArgs;
const addMcpServer = remote.addMcpServer as unknown as AnyArgs;
const removeMcpServer = remote.removeMcpServer as unknown as AnyArgs;
const addMemory = remote.addMemory as unknown as AnyArgs;
const removeMemory = remote.removeMemory as unknown as AnyArgs;
const addStyle = remote.addStyle as unknown as AnyArgs;
const saveStyle = remote.saveStyle as unknown as AnyArgs;
const removeStyle = remote.removeStyle as unknown as AnyArgs;
const addMcpFromPreset = remote.addMcpFromPreset as unknown as AnyArgs;
const disconnectMcpServer = remote.disconnectMcpServer as unknown as AnyArgs;

beforeEach(() => {
	setMockRequestEvent({ platform: { env } });
});

afterEach(async () => {
	clearMockRequestEvent();
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM mcp_servers').run();
	await env.DB.prepare('DELETE FROM memories').run();
	await env.DB.prepare('DELETE FROM styles').run();
});

describe('saveSetting', () => {
	it('persists allowed settings and redirects', async () => {
		await expectRedirect(saveSetting({ key: 'theme', value: 'dark' }) as Promise<unknown>, '/settings');
		expect(await getSetting(env, 'theme')).toBe('dark');
	});

	it('persists system_prompt and user_bio', async () => {
		await expectRedirect(saveSetting({ key: 'system_prompt', value: 'YR PIRATE' }) as Promise<unknown>, '/settings');
		await expectRedirect(saveSetting({ key: 'user_bio', value: 'cats' }) as Promise<unknown>, '/settings');
		expect(await getSetting(env, 'system_prompt')).toBe('YR PIRATE');
		expect(await getSetting(env, 'user_bio')).toBe('cats');
	});

	it('rejects unknown keys', async () => {
		await expectError(saveSetting({ key: 'evil', value: 'x' }) as Promise<unknown>, 400, /Unknown setting/);
	});

	it('rejects invalid theme values', async () => {
		await expectError(saveSetting({ key: 'theme', value: 'sparkly' }) as Promise<unknown>, 400, /Invalid theme/);
	});

	it('rejects out-of-range thresholds', async () => {
		await expectError(
			saveSetting({ key: 'context_compaction_threshold', value: '200' }) as Promise<unknown>,
			400,
			/0 and 100/,
		);
	});

	it('rejects negative thresholds', async () => {
		await expectError(
			saveSetting({ key: 'context_compaction_threshold', value: '-1' }) as Promise<unknown>,
			400,
		);
	});

	it('accepts valid thresholds', async () => {
		await expectRedirect(
			saveSetting({ key: 'context_compaction_threshold', value: '70' }) as Promise<unknown>,
			'/settings',
		);
		expect(await getSetting(env, 'context_compaction_threshold')).toBe('70');
	});

	it('rejects too-small summary token budgets', async () => {
		await expectError(
			saveSetting({ key: 'context_compaction_summary_tokens', value: '100' }) as Promise<unknown>,
			400,
			/256/,
		);
	});

	it('accepts valid summary token budgets', async () => {
		await expectRedirect(
			saveSetting({ key: 'context_compaction_summary_tokens', value: '8192' }) as Promise<unknown>,
			'/settings',
		);
	});
});

describe('addMcpServer', () => {
	it('inserts an http server', async () => {
		await expectRedirect(
			addMcpServer({ name: 'foo', transport: 'http', url: 'https://foo.example' }) as Promise<unknown>,
			'/settings',
		);
		const rows = await listMcpServers(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'foo', transport: 'http', url: 'https://foo.example', enabled: true });
	});

	it('inserts an sse server with auth_json', async () => {
		await expectRedirect(
			addMcpServer({
				name: 'sse',
				transport: 'sse',
				url: 'https://sse.example/sse',
				auth_json: '{"Authorization":"Bearer abc"}',
			}) as Promise<unknown>,
			'/settings',
		);
		const [row] = await listMcpServers(env);
		expect(row.transport).toBe('sse');
		expect(row.authJson).toBe('{"Authorization":"Bearer abc"}');
	});

	it('rejects empty fields', async () => {
		await expectError(
			addMcpServer({ name: '', transport: 'http', url: 'https://x' }) as Promise<unknown>,
			400,
			/Missing/,
		);
	});

	it('rejects bad transport values', async () => {
		await expectError(
			addMcpServer({ name: 'x', transport: 'tcp', url: 'https://x' }) as Promise<unknown>,
			400,
		);
	});

	it('rejects malformed urls', async () => {
		await expectError(
			addMcpServer({ name: 'x', transport: 'http', url: 'not-a-url' }) as Promise<unknown>,
			400,
			/Invalid URL/,
		);
	});

	it('rejects malformed auth_json', async () => {
		await expectError(
			addMcpServer({
				name: 'x',
				transport: 'http',
				url: 'https://x.example',
				auth_json: '{"oops"}',
			}) as Promise<unknown>,
			400,
			/auth_json/,
		);
	});
});

describe('removeMcpServer', () => {
	it('deletes the row and redirects', async () => {
		await runForm(addMcpServer({ name: 'x', transport: 'http', url: 'https://x.example' }) as Promise<unknown>);
		const [row] = await listMcpServers(env);
		await expectRedirect(removeMcpServer({ id: String(row.id) }) as Promise<unknown>, '/settings');
		expect(await listMcpServers(env)).toEqual([]);
	});

	it('rejects non-numeric ids', async () => {
		await expectError(removeMcpServer({ id: 'abc' }) as Promise<unknown>, 400);
	});

	it('rejects zero ids', async () => {
		await expectError(removeMcpServer({ id: '0' }) as Promise<unknown>, 400);
	});
});

describe('addMemory / removeMemory', () => {
	it('inserts a memory and lists it back', async () => {
		await expectRedirect(addMemory({ content: 'I like terse responses.' }) as Promise<unknown>, '/settings');
		const rows = await listMemories(env);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ content: 'I like terse responses.', type: 'manual', source: 'user' });
	});

	it('rejects empty content', async () => {
		await expectError(addMemory({ content: '   ' }) as Promise<unknown>, 400, /required/);
	});

	it('removes by id', async () => {
		await runForm(addMemory({ content: 'gone' }) as Promise<unknown>);
		const [m] = await listMemories(env);
		await expectRedirect(removeMemory({ id: String(m.id) }) as Promise<unknown>, '/settings');
		expect(await listMemories(env)).toEqual([]);
	});

	it('rejects bad ids on remove', async () => {
		await expectError(removeMemory({ id: '0' }) as Promise<unknown>, 400);
		await expectError(removeMemory({ id: 'abc' }) as Promise<unknown>, 400);
	});
});

describe('addStyle / saveStyle / removeStyle', () => {
	it('inserts and lists a style', async () => {
		await expectRedirect(
			addStyle({ name: 'Concise', system_prompt: 'Be brief.' }) as Promise<unknown>,
			'/settings',
		);
		const rows = await listStyles(env);
		expect(rows).toMatchObject([{ name: 'Concise', systemPrompt: 'Be brief.' }]);
	});

	it('rejects empty name or prompt', async () => {
		await expectError(
			addStyle({ name: '   ', system_prompt: 'p' }) as Promise<unknown>,
			400,
			/Name/,
		);
		await expectError(
			addStyle({ name: 'x', system_prompt: '   ' }) as Promise<unknown>,
			400,
			/System prompt/,
		);
	});

	it('saveStyle updates name + prompt', async () => {
		await runForm(addStyle({ name: 'A', system_prompt: 'p' }) as Promise<unknown>);
		const [s] = await listStyles(env);
		await expectRedirect(
			saveStyle({ id: String(s.id), name: 'B', system_prompt: 'q' }) as Promise<unknown>,
			'/settings',
		);
		const after = await getStyle(env, s.id);
		expect(after).toMatchObject({ name: 'B', systemPrompt: 'q' });
	});

	it('saveStyle rejects bad input', async () => {
		await expectError(saveStyle({ id: '0', name: 'x', system_prompt: 'y' }) as Promise<unknown>, 400);
		// Force an existing row, then submit empty name
		await runForm(addStyle({ name: 'A', system_prompt: 'p' }) as Promise<unknown>);
		const [s] = await listStyles(env);
		await expectError(
			saveStyle({ id: String(s.id), name: '', system_prompt: 'y' }) as Promise<unknown>,
			400,
			/Name/,
		);
	});

	it('removeStyle clears the row and any conversation references', async () => {
		await runForm(addStyle({ name: 'A', system_prompt: 'p' }) as Promise<unknown>);
		const [s] = await listStyles(env);
		await env.DB.prepare(
			"INSERT INTO conversations (id, title, created_at, updated_at, style_id) VALUES (?, 'c', 1, 1, ?)",
		)
			.bind('test-style-conv', s.id)
			.run();
		await expectRedirect(removeStyle({ id: String(s.id) }) as Promise<unknown>, '/settings');
		const row = await env.DB.prepare('SELECT style_id FROM conversations WHERE id = ?')
			.bind('test-style-conv')
			.first<{ style_id: number | null }>();
		expect(row?.style_id).toBeNull();
		await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind('test-style-conv').run();
	});
});

describe('addMcpFromPreset', () => {
	it('creates a no-auth preset (Context7) and redirects to settings', async () => {
		await expectRedirect(addMcpFromPreset({ preset_id: 'context7' }) as Promise<unknown>, '/settings');
		const [row] = await listMcpServers(env);
		expect(row.name).toBe('Context7 (docs)');
		expect(row.url).toMatch(/^https:\/\//);
		expect(row.enabled).toBe(true);
	});

	it('creates an OAuth preset disabled and redirects into the connect flow', async () => {
		await expectRedirect(addMcpFromPreset({ preset_id: 'github' }) as Promise<unknown>, '/settings/mcp/');
		const [row] = await listMcpServers(env);
		expect(row.name).toBe('GitHub');
		expect(row.enabled).toBe(false);
	});

	it('rejects unknown preset ids', async () => {
		await expectError(addMcpFromPreset({ preset_id: 'nope' }) as Promise<unknown>, 400, /Unknown MCP preset/);
	});
});

describe('disconnectMcpServer', () => {
	it('clears OAuth tokens and disables the row', async () => {
		// Seed a server with OAuth client + access token.
		await runForm(
			addMcpServer({ name: 'gh', transport: 'http', url: 'https://api.github.example/mcp' }) as Promise<unknown>,
		);
		const [row] = await listMcpServers(env);
		await setMcpServerOauthClient(env, row.id, {
			authorizationServer: 'https://as.example',
			authorizationEndpoint: 'https://as.example/authorize',
			tokenEndpoint: 'https://as.example/token',
			registrationEndpoint: null,
			clientId: 'cid',
			clientSecret: null,
			scopes: null,
		});
		await setMcpServerOauthTokens(env, row.id, {
			accessToken: 'AT',
			refreshToken: 'RT',
			expiresAt: Date.now() + 60_000,
		});

		await expectRedirect(disconnectMcpServer({ id: String(row.id) }) as Promise<unknown>, '/settings');
		const refreshed = (await listMcpServers(env)).find((s) => s.id === row.id);
		expect(refreshed?.enabled).toBe(false);
		expect(refreshed?.oauth?.accessToken).toBeNull();
		expect(refreshed?.oauth?.refreshToken).toBeNull();
		// Client metadata is preserved so the user can reconnect without re-discovering.
		expect(refreshed?.oauth?.clientId).toBe('cid');
	});
});
