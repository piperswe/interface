import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import * as remote from './settings.remote';

// The remote functions are typed as opaque `RemoteForm`s by SvelteKit. Under
// the test alias for `$app/server` they're plain callables (see
// test/shims/app-server.ts), so we cast through `unknown` once.
type AnyArgs = (...args: unknown[]) => Promise<unknown>;
const saveSetting = remote.saveSetting as unknown as AnyArgs;
const addMcpServer = remote.addMcpServer as unknown as AnyArgs;
const removeMcpServer = remote.removeMcpServer as unknown as AnyArgs;
import { getSetting } from './server/settings';
import { listMcpServers } from './server/mcp_servers';

beforeEach(() => {
	setMockRequestEvent({ platform: { env } });
});

afterEach(async () => {
	clearMockRequestEvent();
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM mcp_servers').run();
});

async function expectRedirect(promise: Promise<unknown>, locationStartsWith: string) {
	try {
		await promise;
		throw new Error('expected redirect');
	} catch (e) {
		if (!isRedirect(e)) throw e;
		expect(e.location.startsWith(locationStartsWith)).toBe(true);
	}
}

async function expectError(promise: Promise<unknown>, status: number, msg?: RegExp) {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
		if (msg) expect(String(e.body.message)).toMatch(msg);
	}
}

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

	it('accepts the model_list key with arbitrary text', async () => {
		await expectRedirect(saveSetting({ key: 'model_list', value: 'a|A\nb|B' }) as Promise<unknown>, '/settings');
		expect(await getSetting(env, 'model_list')).toBe('a|A\nb|B');
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
		await addMcpServer({ name: 'x', transport: 'http', url: 'https://x.example' }).catch((e) => {
			// addMcpServer throws a redirect — ignore.
			if (!isRedirect(e)) throw e;
		});
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
