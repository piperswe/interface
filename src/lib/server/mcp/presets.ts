// Curated catalog of well-known MCP servers. The Settings page exposes these
// as a one-click "Add" dropdown that calls `addMcpFromPreset`. Adding a new
// entry: append below; pick a stable `id`, the public MCP endpoint URL, and
// the auth mode the server advertises.
//
// `authMode`:
//   'oauth'  — server requires OAuth 2.1 (we route through
//              /settings/mcp/[id]/connect for discovery + auth + token store).
//   'bearer' — operator pastes a static token; we store it in `auth_json`.
//   'none'   — no authentication; tools are public.

export type McpServerAuthMode = 'oauth' | 'bearer' | 'none';

export type McpServerPreset = {
	id: string;
	label: string;
	url: string;
	transport: 'http' | 'sse';
	authMode: McpServerAuthMode;
	description: string;
};

export const MCP_SERVER_PRESETS: readonly McpServerPreset[] = [
	{
		id: 'cloudflare',
		label: 'Cloudflare',
		url: 'https://mcp.cloudflare.com/mcp',
		transport: 'http',
		authMode: 'oauth',
		description: 'Unified Cloudflare API: AI Search, Workers, KV, R2, D1, Hyperdrive, GraphQL.',
	},
	{
		id: 'github',
		label: 'GitHub',
		url: 'https://api.githubcopilot.com/mcp',
		transport: 'http',
		authMode: 'oauth',
		description: 'GitHub repos, issues, pull requests, search, and code via the GitHub MCP server.',
	},
	{
		id: 'linear',
		label: 'Linear',
		url: 'https://mcp.linear.app/sse',
		transport: 'sse',
		authMode: 'oauth',
		description: 'Linear issues, projects, and comments.',
	},
	{
		id: 'sentry',
		label: 'Sentry',
		url: 'https://mcp.sentry.dev/mcp',
		transport: 'http',
		authMode: 'oauth',
		description: 'Sentry issues, releases, and replay events.',
	},
	{
		id: 'context7',
		label: 'Context7 (docs)',
		url: 'https://mcp.context7.com/mcp',
		transport: 'http',
		authMode: 'none',
		description: 'Up-to-date library/framework documentation lookup.',
	},
];

export function getMcpPreset(id: string): McpServerPreset | null {
	return MCP_SERVER_PRESETS.find((p) => p.id === id) ?? null;
}
