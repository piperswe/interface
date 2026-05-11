import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUrlTool } from './fetch_url';

const ctx = { env, conversationId: 'c', assistantMessageId: 'a', modelId: 'p/m' };

afterEach(() => {
	vi.restoreAllMocks();
});

describe('fetch_url tool', () => {
	it('rejects missing url', async () => {
		const result = await fetchUrlTool.execute(ctx, {});
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/url/);
	});

	it('rejects malformed url', async () => {
		const result = await fetchUrlTool.execute(ctx, { url: 'not a url' });
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/Invalid URL/);
	});

	it('rejects non-http schemes', async () => {
		const result = await fetchUrlTool.execute(ctx, { url: 'file:///etc/passwd' });
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/Refusing to fetch/);
	});

	// Regression (H1): without the SSRF guard, the LLM could call `fetch_url`
	// on localhost / RFC 1918 / cloud-metadata IPs and read internal HTTP
	// endpoints. The guard rejects them before any fetch fires.
	it('rejects loopback / private / metadata hostnames', async () => {
		for (const url of [
			'http://localhost/',
			'http://127.0.0.1/',
			'http://10.0.0.1/',
			'http://192.168.1.1/',
			'http://169.254.169.254/latest/meta-data/',
			'http://[::1]/',
		]) {
			const result = await fetchUrlTool.execute(ctx, { url });
			expect(result.isError).toBe(true);
			expect(result.content).toMatch(/Refusing to fetch|private|reserved|loopback|metadata/i);
		}
	});

	// Regression (H2): redirect chasing used to be `redirect: 'follow'` with
	// no guard. An attacker page could return `302 Location: http://169.254..`
	// and the worker would read the metadata response. We now re-validate
	// each hop.
	it('refuses to follow a redirect to a private IP', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { location: 'http://169.254.169.254/latest/meta-data/' },
			}),
		);
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com/' });
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/redirect|private|metadata/i);
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
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 500, statusText: 'Server Error' }));
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com' });
		expect(result.isError).toBe(true);
	});

	it('truncates large bodies', async () => {
		const big = 'x'.repeat(300_000);
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(big, { status: 200 }));
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com' });
		expect(result.content).toMatch(/truncated/);
	});

	it('extracts the article body via Readability for HTML by default', async () => {
		const html = `<!doctype html><html><head><title>Hello</title></head><body>
			<header><nav><a href="/">Home</a></nav></header>
			<main><article>
				<h1>Hello world</h1>
				<p>This is a substantial paragraph of body text long enough that Readability decides it is the main article content of the page rather than chrome or boilerplate. We need enough words for the heuristic to score this section highly.</p>
				<p>Another paragraph reinforces the main article body, ensuring Readability picks the article element over the surrounding navigation. Lorem ipsum dolor sit amet consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
			</article></main>
			<footer>(c) 2099 noise that should be stripped</footer>
		</body></html>`;
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
		);
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('mode=readability');
		expect(result.content).toContain('Hello world');
		expect(result.content).toContain('substantial paragraph');
		expect(result.content).not.toContain('Home</a>');
	});

	it('returns raw HTML when readability is explicitly disabled', async () => {
		const html = '<!doctype html><html><body><h1>Raw</h1><p>body</p></body></html>';
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com', readability: false });
		expect(result.content).toContain('mode=raw');
		expect(result.content).toContain('<h1>Raw</h1>');
	});

	it('falls back to raw text for non-HTML responses even when readability is on', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('{"hello":"world"}', { status: 200, headers: { 'content-type': 'application/json' } }),
		);
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com' });
		expect(result.content).toContain('mode=raw');
		expect(result.content).toContain('"hello":"world"');
	});
});
