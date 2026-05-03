import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { setSetting } from './settings';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM conversations').run();
});

async function fetchPage(path: string, init?: RequestInit): Promise<Response> {
	return await exports.default.fetch(new Request(`http://test${path}`, { redirect: 'manual', ...init }));
}

describe('routing', () => {
	it('GET / renders the index page', async () => {
		const res = await fetchPage('/');
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('Conversations');
		expect(html).toContain('href="/settings"');
	});

	it('GET /settings renders provider key statuses', async () => {
		const res = await fetchPage('/settings');
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('Provider keys');
		expect(html).toContain('OPENROUTER_KEY');
		expect(html).toContain('configured'); // OPENROUTER_KEY is seeded by wrangler.jsonc
	});

	it('POST /settings persists theme', async () => {
		const form = new URLSearchParams({ key: 'theme', value: 'dark' });
		const res = await fetchPage('/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
		});
		expect(res.status).toBe(303);

		// Reload settings and check it took effect.
		const get = await fetchPage('/settings');
		const html = await get.text();
		expect(html).toMatch(/data-theme="dark"/);
	});

	it('POST /settings rejects unknown keys', async () => {
		const form = new URLSearchParams({ key: 'evil', value: 'whatever' });
		const res = await fetchPage('/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
		});
		expect(res.status).toBe(400);
	});

	it('POST /settings rejects invalid theme values', async () => {
		const form = new URLSearchParams({ key: 'theme', value: 'sparkly' });
		const res = await fetchPage('/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form.toString(),
		});
		expect(res.status).toBe(400);
	});

	it('theme cookie persists across pages', async () => {
		await setSetting(env, 'theme', 'dark');
		const res = await fetchPage('/');
		const html = await res.text();
		expect(html).toMatch(/data-theme="dark"/);
	});

	it('GET unknown path returns 404', async () => {
		const res = await fetchPage('/no-such-thing');
		expect(res.status).toBe(404);
	});
});
