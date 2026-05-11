import { z } from 'zod';
import { validateOrThrow, parseJsonWith } from '$lib/zod-utils';
import type { McpJsonRpcRequest, McpJsonRpcResponse, McpToolCallResult, McpToolDescriptor } from './types';

const mcpJsonRpcResponseSchema = z.union([
	z
		.object({
			jsonrpc: z.literal('2.0'),
			id: z.union([z.number(), z.string()]),
			result: z.unknown(),
		})
		.passthrough(),
	z
		.object({
			jsonrpc: z.literal('2.0'),
			id: z.union([z.number(), z.string()]),
			error: z
				.object({
					code: z.number(),
					message: z.string(),
					data: z.unknown().optional(),
				})
				.passthrough(),
		})
		.passthrough(),
]);

const mcpAuthHeadersSchema = z.record(z.string(), z.string());

const mcpListToolsResultSchema = z
	.object({
		tools: z
			.array(
				z
					.object({
						name: z.string(),
						description: z.string().optional(),
						inputSchema: z.object({}).passthrough().optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

const mcpToolCallResultSchema = z
	.object({
		content: z.array(
			z.union([
				z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
				z
					.object({
						type: z.literal('image'),
						data: z.string(),
						mimeType: z.string(),
					})
					.passthrough(),
			]),
		),
		isError: z.boolean().optional(),
	})
	.passthrough();

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
		const raw = await this.#request('tools/list', {});
		if (raw == null) return [];
		const result = validateOrThrow(
			mcpListToolsResultSchema,
			raw,
			`MCP tools/list result from ${this.#url}`,
		);
		return (result.tools ?? []) as McpToolDescriptor[];
	}

	async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
		const raw = await this.#request('tools/call', { name, arguments: args });
		if (raw == null) return { content: [], isError: true };
		return validateOrThrow(
			mcpToolCallResultSchema,
			raw,
			`MCP tools/call result for "${name}" from ${this.#url}`,
		) as McpToolCallResult;
	}

	async #buildHeaders(force: boolean): Promise<Headers> {
		// Use the Headers API so duplicates with different casing collapse
		// correctly — `Object.assign({}, ...)` is case-sensitive on JS object
		// keys, so an `auth_json` containing `authorization` (lowercase) would
		// shadow our uppercase `Authorization`. `Headers.set` is canonical.
		const headers = new Headers({
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		});
		if (this.#auth) {
			for (const [name, value] of Object.entries(this.#auth)) {
				headers.set(name, value);
			}
		}
		if (this.#getAccessToken) {
			const token = await this.#getAccessToken({ force });
			// OAuth token wins over any static `Authorization` in auth_json so
			// the two sources can't fight (and we can't accidentally ship the
			// wrong bearer to the upstream MCP).
			if (token) headers.set('Authorization', `Bearer ${token}`);
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
			: (validateOrThrow(
					mcpJsonRpcResponseSchema,
					await res.json(),
					`MCP JSON-RPC response from ${this.#url}`,
				) as McpJsonRpcResponse);
		if ('error' in response) throw new Error(response.error.message);
		return response.result;
	}
}

// 1 MiB upper bound on the in-memory SSE accumulator. A misbehaving upstream
// MCP server that never emits `\n\n` would otherwise grow the buffer until the
// Worker's 128 MB heap cap kills the isolate. Frames in JSON-RPC are normally
// small; this is generous.
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

async function readSseSingleResponse(res: Response): Promise<McpJsonRpcResponse> {
	if (!res.body) throw new Error('MCP response has no body');
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: true });
		if (buffer.length > MAX_SSE_BUFFER_BYTES) {
			try {
				await reader.cancel();
			} catch {
				/* ignore */
			}
			throw new Error(
				`MCP SSE frame exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a delimiter`,
			);
		}
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
				const parsed = parseJsonWith(mcpJsonRpcResponseSchema, dataLines.join('\n'));
				if (!parsed) throw new Error('MCP SSE frame did not match the JSON-RPC response shape');
				return parsed as McpJsonRpcResponse;
			}
			buffer = buffer.slice(newlineIdx + 2);
		}
		if (done) break;
	}
	throw new Error('MCP SSE stream ended without a JSON-RPC response');
}

function parseAuth(authJson: string | null | undefined): Record<string, string> | null {
	if (!authJson) return null;
	return parseJsonWith(mcpAuthHeadersSchema, authJson);
}
