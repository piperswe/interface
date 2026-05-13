import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import type { WebSearchBackend, WebSearchResponse, WebSearchResult } from './types';

// Kagi Search API: https://help.kagi.com/kagi/api/search.html
// Authorization header carries a Bot token; results are returned under `data`.

const kagiSearchItemSchema = z
	.object({
		published: z.string().optional(),
		snippet: z.string().optional(),
		t: z.number(), // 0 = result, 1 = related search
		title: z.string().optional(),
		url: z.string().optional(),
	})
	.passthrough();

const kagiResponseSchema = z
	.object({
		data: z.array(kagiSearchItemSchema).optional(),
		error: z.array(z.object({ code: z.number(), msg: z.string() }).passthrough()).optional(),
	})
	.passthrough();

export class KagiSearchBackend implements WebSearchBackend {
	readonly id = 'kagi';
	#apiKey: string;

	constructor(apiKey: string) {
		this.#apiKey = apiKey;
	}

	async search(query: string, options: { count?: number; signal?: AbortSignal } = {}): Promise<WebSearchResponse> {
		const url = new URL('https://kagi.com/api/v0/search');
		url.searchParams.set('q', query);
		if (options.count) url.searchParams.set('limit', String(Math.min(options.count, 25)));

		try {
			const res = await fetch(url.toString(), {
				headers: { Authorization: `Bot ${this.#apiKey}` },
				signal: options.signal,
			});
			if (!res.ok) return { error: `Kagi search HTTP ${res.status}`, ok: false };
			const validated = safeValidate(kagiResponseSchema, await res.json());
			if (!validated.ok) {
				return { error: `Kagi response validation failed: ${validated.error}`, ok: false };
			}
			const body = validated.value;
			if (body.error?.length) return { error: body.error.map((e) => e.msg).join('; '), ok: false };
			const results: WebSearchResult[] = (body.data ?? [])
				.filter((d): d is typeof d & { url: string; title: string } => d.t === 0 && !!d.url && !!d.title)
				.map((d) => ({
					publishedAt: d.published ?? null,
					snippet: d.snippet ?? '',
					title: d.title,
					url: d.url,
				}));
			return { ok: true, results };
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e), ok: false };
		}
	}
}
