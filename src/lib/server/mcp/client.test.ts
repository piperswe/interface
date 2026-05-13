import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAuthError, McpHttpClient } from './client';

afterEach(() => {
	vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json' },
		status,
	});
}

function sseResponse(body: unknown): Response {
	const text = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
	return new Response(text, { headers: { 'content-type': 'text/event-stream' }, status: 200 });
}

describe('McpHttpClient', () => {
	it('listTools returns the tools array from a JSON response', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse({ id: 1, jsonrpc: '2.0', result: { tools: [{ name: 'echo' }] } }));
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		const tools = await client.listTools();
		expect(tools).toEqual([{ name: 'echo' }]);
		expect(fetchSpy).toHaveBeenCalledOnce();
		const call = fetchSpy.mock.calls[0];
		const init = call[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toMatchObject({ method: 'tools/list' });
	});

	it('parses an SSE single-frame response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse({ id: 1, jsonrpc: '2.0', result: { tools: [{ name: 'sse_tool' }] } }));
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		const tools = await client.listTools();
		expect(tools).toEqual([{ name: 'sse_tool' }]);
	});

	it('callTool returns the tool result body', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				id: 1,
				jsonrpc: '2.0',
				result: { content: [{ text: 'pong', type: 'text' }] },
			}),
		);
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		const result = await client.callTool('ping', {});
		expect(result.content).toEqual([{ text: 'pong', type: 'text' }]);
	});

	it('throws when the JSON-RPC response is an error', async () => {
		vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse({ error: { code: -32601, message: 'not found' }, id: 1, jsonrpc: '2.0' }));
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		await expect(client.listTools()).rejects.toThrow(/not found/);
	});

	it('attaches custom auth headers from authJson', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ id: 1, jsonrpc: '2.0', result: { tools: [] } }));
		const client = new McpHttpClient({
			authJson: '{"X-Api-Key":"secret"}',
			url: 'https://mcp.test/jsonrpc',
		});
		await client.listTools();
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers as Record<string, string>);
		expect(headers.get('X-Api-Key')).toBe('secret');
	});

	it('throws when the HTTP response is non-2xx', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('err', { status: 500 }));
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		await expect(client.listTools()).rejects.toThrow(/MCP HTTP 500/);
	});

	it('listTools returns [] when the response result has no tools field', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ id: 1, jsonrpc: '2.0', result: {} }));
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		expect(await client.listTools()).toEqual([]);
	});

	it('callTool returns an error sentinel when the result is missing', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ id: 1, jsonrpc: '2.0', result: undefined }));
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		const result = await client.callTool('ping', {});
		expect(result.isError).toBe(true);
	});

	it('ignores invalid auth_json gracefully', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ id: 1, jsonrpc: '2.0', result: { tools: [] } }));
		const client = new McpHttpClient({
			authJson: 'not-json',
			url: 'https://mcp.test/jsonrpc',
		});
		await client.listTools();
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		// No custom header should be attached.
		expect(headers['X-Api-Key']).toBeUndefined();
		expect(headers.Authorization).toBeUndefined();
	});

	it('rejects an SSE stream that ends without a JSON-RPC frame', async () => {
		vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(': comment\n\n', { headers: { 'content-type': 'text/event-stream' }, status: 200 }));
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		await expect(client.listTools()).rejects.toThrow(/SSE stream ended/);
	});

	describe('OAuth bearer token integration', () => {
		// `headers` is now a `Headers` instance (was a plain object) so the
		// case-insensitive merge in #buildHeaders works correctly across both
		// `auth_json` and the OAuth getter.
		function authOf(init: RequestInit | undefined): string | null {
			if (!init) return null;
			if (init.headers instanceof Headers) return init.headers.get('Authorization');
			const rec = init.headers as Record<string, string> | undefined;
			return rec?.Authorization ?? null;
		}

		it('attaches the Bearer header when getAccessToken returns a string', async () => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ id: 1, jsonrpc: '2.0', result: { tools: [] } }));
			const client = new McpHttpClient({
				getAccessToken: async () => 'AT',
				url: 'https://mcp.test/jsonrpc',
			});
			await client.listTools();
			const init = fetchSpy.mock.calls[0][1] as RequestInit;
			expect(authOf(init)).toBe('Bearer AT');
		});

		it('skips the Bearer header when getAccessToken returns null', async () => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ id: 1, jsonrpc: '2.0', result: { tools: [] } }));
			const client = new McpHttpClient({
				getAccessToken: async () => null,
				url: 'https://mcp.test/jsonrpc',
			});
			await client.listTools();
			const init = fetchSpy.mock.calls[0][1] as RequestInit;
			expect(authOf(init)).toBeNull();
		});

		it('retries once on 401 with force:true and succeeds on the second attempt', async () => {
			const tokens = ['stale', 'fresh'];
			const calls: string[] = [];
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
				const auth = authOf(init);
				calls.push(auth ?? '');
				if (auth === 'Bearer stale') return new Response('unauth', { status: 401 });
				return jsonResponse({ id: 1, jsonrpc: '2.0', result: { tools: [{ name: 'ok' }] } });
			});
			const tokenCalls: Array<{ force?: boolean }> = [];
			const client = new McpHttpClient({
				getAccessToken: async (opts = {}) => {
					tokenCalls.push(opts);
					return opts.force ? tokens[1] : tokens[0];
				},
				url: 'https://mcp.test/jsonrpc',
			});
			const tools = await client.listTools();
			expect(tools).toEqual([{ name: 'ok' }]);
			expect(calls).toEqual(['Bearer stale', 'Bearer fresh']);
			expect(tokenCalls).toEqual([{ force: false }, { force: true }]);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});

		it('throws McpAuthError if the second 401 retry also fails', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauth', { status: 401 }));
			const client = new McpHttpClient({
				getAccessToken: async () => 'AT',
				url: 'https://mcp.test/jsonrpc',
			});
			await expect(client.listTools()).rejects.toBeInstanceOf(McpAuthError);
		});

		it('does not attempt a 401 retry without a token getter', async () => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauth', { status: 401 }));
			const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
			await expect(client.listTools()).rejects.toBeInstanceOf(McpAuthError);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		// Regression: header merging used to be `Object.assign(obj, auth)`,
		// which is case-sensitive on plain object keys. An `auth_json` with a
		// lowercase `authorization` key would shadow the OAuth `Authorization`,
		// silently sending the wrong bearer (or none at all). With the Headers
		// API the OAuth token wins regardless of casing.
		it('OAuth token overrides a lowercase `authorization` from auth_json', async () => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ id: 1, jsonrpc: '2.0', result: { tools: [] } }));
			const client = new McpHttpClient({
				authJson: '{"authorization": "Token static"}',
				getAccessToken: async () => 'AT-oauth',
				url: 'https://mcp.test/jsonrpc',
			});
			await client.listTools();
			const init = fetchSpy.mock.calls[0][1] as RequestInit;
			expect(authOf(init)).toBe('Bearer AT-oauth');
		});
	});
});
