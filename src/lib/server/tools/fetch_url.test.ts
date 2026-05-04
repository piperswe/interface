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
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
		);
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

	it('prefers a markdown alternate link over Readability when present', async () => {
		const html = `<!doctype html><html><head>
			<title>Cloudflare Page</title>
			<link rel="alternate" type="text/markdown" href="/page.md">
		</head><body><article><h1>HTML version</h1><p>Some chrome and rendered noise.</p></article></body></html>`;
		const markdown = '# Hello\n\nThis is the curated markdown body.';
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
			)
			.mockResolvedValueOnce(
				new Response(markdown, { status: 200, headers: { 'content-type': 'text/markdown' } }),
			);
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com/page' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('mode=markdown-alternate');
		expect(result.content).toContain('# Hello');
		expect(result.content).toContain('curated markdown body');
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[1][0]).toBe('https://example.com/page.md');
	});

	it('falls back to Readability when the markdown alternate fetch fails', async () => {
		const html = `<!doctype html><html><head>
			<title>Page</title>
			<link rel="alternate" type="text/markdown" href="/missing.md">
		</head><body>
			<main><article>
				<h1>Article heading</h1>
				<p>This is a substantial paragraph of body text long enough that Readability decides it is the main article content of the page rather than chrome or boilerplate. We need enough words for the heuristic to score this section highly.</p>
				<p>Another paragraph reinforces the main article body, ensuring Readability picks the article element. Lorem ipsum dolor sit amet consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
			</article></main>
		</body></html>`;
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
			)
			.mockResolvedValueOnce(new Response('not found', { status: 404 }));
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com/page' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('mode=readability');
		expect(result.content).toContain('Article heading');
	});

	it('ignores the markdown alternate when readability is disabled', async () => {
		const html = `<!doctype html><html><head>
			<link rel="alternate" type="text/markdown" href="/page.md">
		</head><body><h1>Raw</h1></body></html>`;
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
			);
		const result = await fetchUrlTool.execute(ctx, {
			url: 'https://example.com/page',
			readability: false,
		});
		expect(result.content).toContain('mode=raw');
		expect(result.content).toContain('<h1>Raw</h1>');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('resolves a relative markdown alternate href against the page URL', async () => {
		const html = `<!doctype html><html><head>
			<link rel="alternate" type="text/markdown" href="y.md">
		</head><body><p>noise</p></body></html>`;
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
			)
			.mockResolvedValueOnce(
				new Response('# Resolved\n', { status: 200, headers: { 'content-type': 'text/markdown' } }),
			);
		const result = await fetchUrlTool.execute(ctx, { url: 'https://example.com/docs/x/' });
		expect(result.content).toContain('mode=markdown-alternate');
		expect(fetchSpy.mock.calls[1][0]).toBe('https://example.com/docs/x/y.md');
	});
});
