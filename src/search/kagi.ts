import type { WebSearchBackend, WebSearchResponse, WebSearchResult } from './types';

// Kagi Search API: https://help.kagi.com/kagi/api/search.html
// Authorization header carries a Bot token; results are returned under `data`.

type KagiSearchItem = {
	t: number; // 0 = result, 1 = related search
	url?: string;
	title?: string;
	snippet?: string;
	published?: string;
};

type KagiResponse = {
	data?: KagiSearchItem[];
	error?: Array<{ code: number; msg: string }>;
};

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
			const body = (await res.json()) as KagiResponse;
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
