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

const ctx = { assistantMessageId: 'a', conversationId: 'c', env, modelId: 'p/m' };

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
					{ snippet: 'A page about cats', title: 'Cats!', url: 'https://a.example/cats' },
					{ snippet: 'Comparing.', title: 'Dogs vs cats', url: 'https://b.example/dogs' },
				],
			}),
		);
		const result = await tool.execute(ctx, { query: 'cats' });
		expect(result.content).toContain('[1]');
		expect(result.content).toContain('Cats!');
		expect(result.content).toContain('https://a.example/cats');
		expect(result.citations).toHaveLength(2);
	});

	// Regression: inline citations need globally stable numbering across the
	// turn. When the loop wires `ctx.registerCitation`, the tool must use it
	// so two `web_search` calls in the same turn assign each unique URL a
	// single index, and the tool's [N] markers in the result text match.
	it('uses ctx.registerCitation for stable global numbering across calls', async () => {
		const seen = new Map<string, number>();
		const collected: { url: string; title: string; snippet?: string }[] = [];
		const registerCitation = (c: { url: string; title: string; snippet?: string }) => {
			const existing = seen.get(c.url);
			if (existing !== undefined) return existing;
			const idx = collected.length + 1;
			collected.push(c);
			seen.set(c.url, idx);
			return idx;
		};
		const turnCtx = { ...ctx, registerCitation };

		const first = createWebSearchTool(
			new StubBackend({
				ok: true,
				results: [
					{ snippet: '', title: 'A', url: 'https://a/' },
					{ snippet: '', title: 'B', url: 'https://b/' },
				],
			}),
		);
		const r1 = await first.execute(turnCtx, { query: 'first' });
		// First call: A=1, B=2.
		expect(r1.content).toContain('[1] A');
		expect(r1.content).toContain('[2] B');
		// Citations are pushed via registerCitation, not result.citations, when
		// the ctx callback is provided.
		expect(r1.citations).toBeUndefined();

		const second = createWebSearchTool(
			new StubBackend({
				ok: true,
				results: [
					// A repeats — must keep index 1.
					{ snippet: '', title: 'A', url: 'https://a/' },
					// New URL — gets the next free index, 3.
					{ snippet: '', title: 'C', url: 'https://c/' },
				],
			}),
		);
		const r2 = await second.execute(turnCtx, { query: 'second' });
		expect(r2.content).toContain('[1] A');
		expect(r2.content).toContain('[3] C');
		expect(collected.map((c) => c.url)).toEqual(['https://a/', 'https://b/', 'https://c/']);
	});

	it('instructs the model to use [N] markers inline', async () => {
		const tool = createWebSearchTool(
			new StubBackend({
				ok: true,
				results: [{ snippet: '', title: 'X', url: 'https://x/' }],
			}),
		);
		const result = await tool.execute(ctx, { query: 'x' });
		expect(result.content).toMatch(/\[N\] markers/);
	});

	it('surfaces backend errors', async () => {
		const tool = createWebSearchTool(new StubBackend({ error: 'rate limited', ok: false }));
		const result = await tool.execute(ctx, { query: 'cats' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('rate limited');
	});
});
