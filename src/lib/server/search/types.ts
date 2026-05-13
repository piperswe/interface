// Pluggable web-search backend interface. Implementations must accept
// `signal` for cancellation and surface an `error` shape when the upstream
// rejects so callers can distinguish "no results" from "backend failure".

export type WebSearchResult = {
	url: string;
	title: string;
	snippet: string;
	publishedAt?: string | null;
};

export type WebSearchResponse = { ok: true; results: WebSearchResult[] } | { ok: false; error: string };

export interface WebSearchBackend {
	readonly id: string;
	search(query: string, options?: { count?: number; signal?: AbortSignal }): Promise<WebSearchResponse>;
}
