// Subset of the MCP wire protocol we use. Full spec:
// https://modelcontextprotocol.io/specification/2025-06-18/

export type McpJsonRpcRequest = {
	jsonrpc: '2.0';
	id: number | string;
	method: string;
	params?: unknown;
};

export type McpJsonRpcResponse =
	| { jsonrpc: '2.0'; id: number | string; result: unknown }
	| { jsonrpc: '2.0'; id: number | string; error: { code: number; message: string; data?: unknown } };

export type McpToolDescriptor = {
	name: string;
	description?: string;
	inputSchema?: object;
};

export type McpToolCallResult = {
	content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
	isError?: boolean;
};

export type McpServerRow = {
	id: number;
	name: string;
	transport: 'http' | 'sse' | 'stdio';
	url: string | null;
	command: string | null;
	envJson: string | null;
	authJson: string | null;
	enabled: boolean;
	oauth: McpOauthState | null;
};

// Materialised OAuth state for an MCP server. Only present when at least one
// of the oauth_* columns is set on the row; if the server is OAuth-protected
// but unconnected, `accessToken` will be null.
export type McpOauthState = {
	authorizationServer: string | null;
	authorizationEndpoint: string | null;
	tokenEndpoint: string | null;
	registrationEndpoint: string | null;
	clientId: string | null;
	clientSecret: string | null;
	scopes: string | null;
	accessToken: string | null;
	refreshToken: string | null;
	expiresAt: number | null;
};
