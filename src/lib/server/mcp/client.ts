import type { McpJsonRpcRequest, McpJsonRpcResponse, McpToolCallResult, McpToolDescriptor } from './types';

// Minimal HTTP-streamable MCP client. Each call POSTs a JSON-RPC request to
// the server's URL and parses the JSON or text/event-stream response. Stateful
// transports (SSE keep-alive, server-pushed notifications) are deferred to
// Phase 0.6 — the v1 use case is "operator runs an MCP server, we POST tools
// and call_tool, parse single-shot replies."

export type AccessTokenGetter = (opts?: { force?: boolean }) => Promise<string | null>;

export type McpClientOptions = {
	url: string;
	authJson?: string | null;
	signal?: AbortSignal;
	// Returns the current access token. Called each request; `force: true` is
	// passed on retry after a 401 so the resolver can refresh even when its
	// cached token isn't expired by clock.
	getAccessToken?: AccessTokenGetter;
};

export class McpAuthError extends Error {
	constructor(message = 'MCP server requires authorization') {
		super(message);
		this.name = 'McpAuthError';
	}
}

export class McpHttpClient {
	#url: string;
	#auth: Record<string, string> | null;
	#signal: AbortSignal | undefined;
	#getAccessToken: AccessTokenGetter | null;
	#nextId = 1;

	constructor({ url, authJson, signal, getAccessToken }: McpClientOptions) {
		this.#url = url;
		this.#auth = parseAuth(authJson);
		this.#signal = signal;
		this.#getAccessToken = getAccessToken ?? null;
	}

	async listTools(): Promise<McpToolDescriptor[]> {
		const result = (await this.#request('tools/list', {})) as { tools?: McpToolDescriptor[] } | undefined;
		return result?.tools ?? [];
	}

	async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
		const result = (await this.#request('tools/call', { name, arguments: args })) as McpToolCallResult | undefined;
		return result ?? { content: [], isError: true };
	}

	async #buildHeaders(force: boolean): Promise<Record<string, string>> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		};
		if (this.#auth) Object.assign(headers, this.#auth);
		if (this.#getAccessToken) {
			const token = await this.#getAccessToken({ force });
			if (token) headers.Authorization = `Bearer ${token}`;
		}
		return headers;
	}

	async #request(method: string, params: unknown): Promise<unknown> {
		const id = this.#nextId++;
		const body: McpJsonRpcRequest = { jsonrpc: '2.0', id, method, params };
		const bodyJson = JSON.stringify(body);
		let headers = await this.#buildHeaders(false);
		let res = await fetch(this.#url, { method: 'POST', headers, body: bodyJson, signal: this.#signal });
		// One retry on 401 with a forced token refresh — covers servers that
		// invalidate access tokens before our cached expiry.
		if (res.status === 401 && this.#getAccessToken) {
			headers = await this.#buildHeaders(true);
			res = await fetch(this.#url, { method: 'POST', headers, body: bodyJson, signal: this.#signal });
		}
		if (res.status === 401) {
			throw new McpAuthError(`MCP server requires authorization (${this.#url})`);
		}
		if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
		const ct = res.headers.get('content-type') ?? '';
		const response = ct.includes('text/event-stream')
			? await readSseSingleResponse(res)
			: ((await res.json()) as McpJsonRpcResponse);
		if ('error' in response) throw new Error(response.error.message);
		return response.result;
	}
}

async function readSseSingleResponse(res: Response): Promise<McpJsonRpcResponse> {
	if (!res.body) throw new Error('MCP response has no body');
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: true });
		const newlineIdx = buffer.indexOf('\n\n');
		if (newlineIdx !== -1) {
			const frame = buffer.slice(0, newlineIdx);
			const dataLines = frame
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trimStart());
			if (dataLines.length > 0) {
				try {
					await reader.cancel();
				} catch {
					/* ignore */
				}
				return JSON.parse(dataLines.join('\n')) as McpJsonRpcResponse;
			}
			buffer = buffer.slice(newlineIdx + 2);
		}
		if (done) break;
	}
	throw new Error('MCP SSE stream ended without a JSON-RPC response');
}

function parseAuth(authJson: string | null | undefined): Record<string, string> | null {
	if (!authJson) return null;
	try {
		const parsed = JSON.parse(authJson) as Record<string, string>;
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}
