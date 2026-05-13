import { afterEach, describe, expect, it, vi } from 'vitest';
import { KagiSearchBackend } from './kagi';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('KagiSearchBackend', () => {
	it('exposes a stable backend id', () => {
		expect(new KagiSearchBackend('k').id).toBe('kagi');
	});

	it('encodes the query and limit on the request URL', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' }, status: 200 }));
		await new KagiSearchBackend('secret').search('hello world', { count: 7 });
		const url = fetchSpy.mock.calls[0][0] as string;
		expect(url).toContain('https://kagi.com/api/v0/search');
		expect(url).toContain('q=hello+world');
		expect(url).toContain('limit=7');
	});

	it('clamps the limit to 25', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
		await new KagiSearchBackend('s').search('q', { count: 999 });
		expect(fetchSpy.mock.calls[0][0]).toContain('limit=25');
	});

	it('sends the api key as a Bot Authorization header', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
		await new KagiSearchBackend('top-secret').search('q');
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe('Bot top-secret');
	});

	it('parses result items, dropping related-search rows', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					data: [
						{ published: '2099-01-01', snippet: 'sa', t: 0, title: 'A', url: 'https://a' },
						{ t: 1, url: 'related-search-url' },
						{ snippet: 'sb', t: 0, title: 'B', url: 'https://b' },
					],
				}),
				{ status: 200 },
			),
		);
		const out = await new KagiSearchBackend('s').search('q');
		if (!out.ok) throw new Error('expected ok');
		expect(out.results.map((r) => r.url)).toEqual(['https://a', 'https://b']);
		expect(out.results[0].publishedAt).toBe('2099-01-01');
		expect(out.results[1].publishedAt).toBeNull();
	});

	it('skips items missing url or title', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					data: [
						{ t: 0, url: 'https://a' /* no title */ },
						{ t: 0, title: 'B' /* no url */ },
						{ snippet: 'sc', t: 0, title: 'C', url: 'https://c' },
					],
				}),
				{ status: 200 },
			),
		);
		const out = await new KagiSearchBackend('s').search('q');
		if (!out.ok) throw new Error('expected ok');
		expect(out.results.map((r) => r.url)).toEqual(['https://c']);
	});

	it('returns an error result for non-2xx responses', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
		const out = await new KagiSearchBackend('s').search('q');
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toMatch(/403/);
	});

	it('reports api errors when the body has an error array', async () => {
		vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: [{ code: 1, msg: 'rate limited' }] }), { status: 200 }));
		const out = await new KagiSearchBackend('s').search('q');
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toBe('rate limited');
	});

	it('catches network exceptions and surfaces them as error results', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
		const out = await new KagiSearchBackend('s').search('q');
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toBe('offline');
	});

	it('returns an empty result list when data is missing', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
		const out = await new KagiSearchBackend('s').search('q');
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.results).toEqual([]);
	});
});
