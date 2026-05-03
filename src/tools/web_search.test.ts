import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WebSearchBackend, WebSearchResponse } from '../search/types';
import { createWebSearchTool } from './web_search';

class StubBackend implements WebSearchBackend {
	readonly id = 'stub';
	#response: WebSearchResponse;
	constructor(response: WebSearchResponse) {
		this.#response = response;
	}
	async search(): Promise<WebSearchResponse> {
		return this.#response;
	}
}

const ctx = { env, conversationId: 'c', assistantMessageId: 'a' };

describe('web_search tool', () => {
	it('rejects missing query', async () => {
		const tool = createWebSearchTool(new StubBackend({ ok: true, results: [] }));
		const result = await tool.execute(ctx, {});
		expect(result.isError).toBe(true);
	});

	it('returns "no results" content when backend returns empty', async () => {
		const tool = createWebSearchTool(new StubBackend({ ok: true, results: [] }));
		const result = await tool.execute(ctx, { query: 'cats' });
		expect(result.content).toMatch(/No results/);
	});

	it('formats results with citations', async () => {
		const tool = createWebSearchTool(
			new StubBackend({
				ok: true,
				results: [
					{ url: 'https://a.example/cats', title: 'Cats!', snippet: 'A page about cats' },
					{ url: 'https://b.example/dogs', title: 'Dogs vs cats', snippet: 'Comparing.' },
				],
			}),
		);
		const result = await tool.execute(ctx, { query: 'cats' });
		expect(result.content).toContain('[1]');
		expect(result.content).toContain('Cats!');
		expect(result.content).toContain('https://a.example/cats');
		expect(result.citations).toHaveLength(2);
	});

	it('surfaces backend errors', async () => {
		const tool = createWebSearchTool(new StubBackend({ ok: false, error: 'rate limited' }));
		const result = await tool.execute(ctx, { query: 'cats' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('rate limited');
	});
});
