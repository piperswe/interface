import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUrlTool } from './fetch_url';

const ctx = { env, conversationId: 'c', assistantMessageId: 'a' };

afterEach(() => {
	vi.restoreAllMocks();
});

describe('fetch_url tool', () => {
	it('rejects missing url', async () => {
		const result = await fetchUrlTool.execute(ctx, {});
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/Missing/);
	});

	it('rejects malformed url', async () => {
		const result = await fetchUrlTool.execute(ctx, { url: 'not a url' });
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/Invalid URL/);
	});

	it('rejects non-http schemes', async () => {
		const result = await fetchUrlTool.execute(ctx, { url: 'file:///etc/passwd' });
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/non-HTTP/);
	});

	it('returns body for a 2xx response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('hello world', { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } }),
		);
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('HTTP 200');
		expect(result.content).toContain('hello world');
	});

	it('marks non-2xx as error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('nope', { status: 500, statusText: 'Server Error' }),
		);
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com' });
		expect(result.isError).toBe(true);
	});

	it('truncates large bodies', async () => {
		const big = 'x'.repeat(300_000);
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(big, { status: 200 }));
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com' });
		expect(result.content).toMatch(/truncated/);
	});
});
