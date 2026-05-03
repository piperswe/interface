import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpHttpClient } from './client';

afterEach(() => {
	vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function sseResponse(body: unknown): Response {
	const text = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
	return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('McpHttpClient', () => {
	it('listTools returns the tools array from a JSON response', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo' }] } }),
		);
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		const tools = await client.listTools();
		expect(tools).toEqual([{ name: 'echo' }]);
		expect(fetchSpy).toHaveBeenCalledOnce();
		const call = fetchSpy.mock.calls[0];
		const init = call[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toMatchObject({ method: 'tools/list' });
	});

	it('parses an SSE single-frame response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			sseResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'sse_tool' }] } }),
		);
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		const tools = await client.listTools();
		expect(tools).toEqual([{ name: 'sse_tool' }]);
	});

	it('callTool returns the tool result body', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: { content: [{ type: 'text', text: 'pong' }] },
			}),
		);
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		const result = await client.callTool('ping', {});
		expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
	});

	it('throws when the JSON-RPC response is an error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'not found' } }),
		);
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		await expect(client.listTools()).rejects.toThrow(/not found/);
	});

	it('attaches custom auth headers from authJson', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
		);
		const client = new McpHttpClient({
			url: 'https://mcp.test/jsonrpc',
			authJson: '{"X-Api-Key":"secret"}',
		});
		await client.listTools();
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('secret');
	});

	it('throws when the HTTP response is non-2xx', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('err', { status: 500 }));
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		await expect(client.listTools()).rejects.toThrow(/MCP HTTP 500/);
	});

	it('listTools returns [] when the response result has no tools field', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }),
		);
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		expect(await client.listTools()).toEqual([]);
	});

	it('callTool returns an error sentinel when the result is missing', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({ jsonrpc: '2.0', id: 1, result: undefined }),
		);
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		const result = await client.callTool('ping', {});
		expect(result.isError).toBe(true);
	});

	it('ignores invalid auth_json gracefully', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
		);
		const client = new McpHttpClient({
			url: 'https://mcp.test/jsonrpc',
			authJson: 'not-json',
		});
		await client.listTools();
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		const headers = init.headers as Record<string, string>;
		// No custom header should be attached.
		expect(headers['X-Api-Key']).toBeUndefined();
		expect(headers['Authorization']).toBeUndefined();
	});

	it('rejects an SSE stream that ends without a JSON-RPC frame', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(': comment\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
		);
		const client = new McpHttpClient({ url: 'https://mcp.test/jsonrpc' });
		await expect(client.listTools()).rejects.toThrow(/SSE stream ended/);
	});
});
