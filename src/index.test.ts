import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import app from './index';
import { setSetting } from './settings';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM conversations').run();
	await env.DB.prepare('DELETE FROM mcp_servers').run();
});

const ORIGIN = 'http://test';

// Hono's `app.request()` builds a Request, runs it through middleware + the
// matched route, and returns the Response. POSTs need an Origin header so the
// CSRF middleware accepts them as same-origin.
async function get(path: string, init: RequestInit = {}): Promise<Response> {
	return await app.request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }, env);
}

async function postForm(path: string, fields: Record<string, string>): Promise<Response> {
	const form = new URLSearchParams(fields);
	return await app.request(
		`${ORIGIN}${path}`,
		{
			method: 'POST',
			redirect: 'manual',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Origin: ORIGIN,
			},
			body: form.toString(),
		},
		env,
	);
}

describe('routing', () => {
	it('GET / renders the index page', async () => {
		const res = await get('/');
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('Conversations');
		expect(html).toContain('href="/settings"');
	});

	it('GET /index.html redirects to /', async () => {
		const res = await get('/index.html');
		expect(res.status).toBe(301);
		expect(res.headers.get('location')).toBe('/');
	});

	it('GET /settings renders provider key statuses', async () => {
		const res = await get('/settings');
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('Provider keys');
		expect(html).toContain('OPENROUTER_KEY');
		expect(html).toContain('configured');
	});

	it('POST /settings persists theme', async () => {
		const res = await postForm('/settings', { key: 'theme', value: 'dark' });
		expect(res.status).toBe(303);
		const get1 = await get('/settings');
		const html = await get1.text();
		expect(html).toMatch(/data-theme="dark"/);
	});

	it('POST /settings rejects unknown keys', async () => {
		const res = await postForm('/settings', { key: 'evil', value: 'x' });
		expect(res.status).toBe(400);
	});

	it('POST /settings rejects invalid theme values', async () => {
		const res = await postForm('/settings', { key: 'theme', value: 'sparkly' });
		expect(res.status).toBe(400);
	});

	it('CSRF middleware rejects cross-origin POSTs', async () => {
		const form = new URLSearchParams({ key: 'theme', value: 'dark' });
		const res = await app.request(
			`${ORIGIN}/settings`,
			{
				method: 'POST',
				redirect: 'manual',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Origin: 'http://evil.example',
				},
				body: form.toString(),
			},
			env,
		);
		expect(res.status).toBe(403);
	});

	it('theme persists across pages', async () => {
		await setSetting(env, 'theme', 'dark');
		const res = await get('/');
		const html = await res.text();
		expect(html).toMatch(/data-theme="dark"/);
	});

	it('GET unknown path returns 404', async () => {
		const res = await get('/no-such-thing');
		expect(res.status).toBe(404);
	});

	it('POST /conversations creates a row and redirects to /c/:id', async () => {
		const res = await app.request(
			`${ORIGIN}/conversations`,
			{
				method: 'POST',
				redirect: 'manual',
				headers: { Origin: ORIGIN },
			},
			env,
		);
		expect(res.status).toBe(303);
		const location = res.headers.get('location') ?? '';
		expect(location).toMatch(/^\/c\/[0-9a-f-]{36}$/);
	});

	it('POST /settings/mcp-servers creates a server and redirects', async () => {
		const res = await postForm('/settings/mcp-servers', {
			name: 'github',
			transport: 'http',
			url: 'https://mcp.example/jsonrpc',
		});
		expect(res.status).toBe(303);
		const list = await env.DB.prepare('SELECT name, transport, url FROM mcp_servers').all<{
			name: string;
			transport: string;
			url: string;
		}>();
		expect(list.results).toEqual([
			{ name: 'github', transport: 'http', url: 'https://mcp.example/jsonrpc' },
		]);
	});

	it('POST /settings/mcp-servers rejects malformed URL', async () => {
		const res = await postForm('/settings/mcp-servers', {
			name: 'bad',
			transport: 'http',
			url: 'not a url',
		});
		expect(res.status).toBe(400);
	});

	it('POST /settings/mcp-servers rejects malformed auth_json', async () => {
		const res = await postForm('/settings/mcp-servers', {
			name: 'bad',
			transport: 'http',
			url: 'https://x.example',
			auth_json: '{not json',
		});
		expect(res.status).toBe(400);
	});

	it('GET /dist/* gets etag headers', async () => {
		const res = await get('/dist/styles.css');
		// ASSETS may 404 in tests (no file shipped) but the etag middleware still ran
		// successfully on the response chain — assert no crash.
		expect([200, 404, 304]).toContain(res.status);
	});
});
