import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import type { WebSearchBackend, WebSearchResponse, WebSearchResult } from './types';

// Kagi Search API: https://help.kagi.com/kagi/api/search.html
// Authorization header carries a Bot token; results are returned under `data`.

const kagiSearchItemSchema = z
	.object({
		t: z.number(), // 0 = result, 1 = related search
		url: z.string().optional(),
		title: z.string().optional(),
		snippet: z.string().optional(),
		published: z.string().optional(),
	})
	.passthrough();

const kagiResponseSchema = z
	.object({
		data: z.array(kagiSearchItemSchema).optional(),
		error: z
			.array(
				z
					.object({ code: z.number(), msg: z.string() })
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

export class KagiSearchBackend implements WebSearchBackend {
	readonly id = 'kagi';
	#apiKey: string;

	constructor(apiKey: string) {
		this.#apiKey = apiKey;
	}

	async search(
		query: string,
		options: { count?: number; signal?: AbortSignal } = {},
	): Promise<WebSearchResponse> {
		const url = new URL('https://kagi.com/api/v0/search');
		url.searchParams.set('q', query);
		if (options.count) url.searchParams.set('limit', String(Math.min(options.count, 25)));

		try {
			const res = await fetch(url.toString(), {
				headers: { Authorization: `Bot ${this.#apiKey}` },
				signal: options.signal,
			});
			if (!res.ok) return { ok: false, error: `Kagi search HTTP ${res.status}` };
			const validated = safeValidate(kagiResponseSchema, await res.json());
			if (!validated.ok) {
				return { ok: false, error: `Kagi response validation failed: ${validated.error}` };
			}
			const body = validated.value;
			if (body.error?.length) return { ok: false, error: body.error.map((e) => e.msg).join('; ') };
			const results: WebSearchResult[] = (body.data ?? [])
				.filter((d) => d.t === 0 && d.url && d.title)
				.map((d) => ({
					url: d.url!,
					title: d.title!,
					snippet: d.snippet ?? '',
					publishedAt: d.published ?? null,
				}));
			return { ok: true, results };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}
