import { ToolRegistry } from '../../tools/registry';
import { fetchUrlTool } from '../../tools/fetch_url';
import { createWebSearchTool } from '../../tools/web_search';
import { createYnabTools } from '../../tools/ynab';
import { createOpenWeatherMapTools } from '../../tools/openweathermap';
import { KagiSearchBackend } from '../../search/kagi';
import { McpHttpClient } from '../../mcp/client';
import { getMcpServer } from '../../mcp_servers';
import { getValidAccessToken } from '../../mcp/oauth_store';
import { createAgentTool } from '../../tools/agent';
import { createGetModelsTool } from '../../tools/get_models';
import { createSwitchModelTool } from '../../tools/switch_model';
import { createRememberTool } from '../../tools/remember';
import { registerSandboxTools } from '../../tools/sandbox';
import { runJsTool } from '../../tools/run_js';
import { buildCustomTool } from '../../tools/custom_tool_runner';
import { customToolMetaTools } from '../../tools/custom_tools_meta';
import { buildGlobalModelId } from '../../providers/types';
import type { McpServerRow, McpToolDescriptor } from '../../mcp/types';
import type { ProviderModel } from '../../providers/types';
import type { SubAgentRow } from '../../sub_agents';
import type { MemoryRow } from '../../memories';
import type { StyleRow } from '../../styles';
import type { CustomToolRow } from '../../custom_tools';
import { now as nowMs } from '../../clock';

export const MCP_TOOL_CACHE_TTL_MS = 60_000;

export type McpCacheEntry = {
	fetchedAt: number;
	client: McpHttpClient;
	tools: McpToolDescriptor[];
};
export type McpCache = Map<number, McpCacheEntry>;

export type ConversationContext = {
	systemPrompt: string | null;
	userBio: string | null;
	allModels: ProviderModel[];
	subAgents: SubAgentRow[];
	mcpServers: McpServerRow[];
	memories: MemoryRow[];
	styles: StyleRow[];
	customTools: CustomToolRow[];
};

// Base registry — built-in tools + MCP + custom tools. Used directly for the
// parent loop (extended in `buildToolRegistry` with the `agent` tool) and
// re-built fresh per sub-agent invocation as the inner tool set.
export async function buildBaseToolRegistry(
	env: Env,
	mcpCache: McpCache,
	mcpServers: McpServerRow[],
	customTools: CustomToolRow[] = [],
	getModels?: () => ProviderModel[],
): Promise<ToolRegistry> {
	const registry = new ToolRegistry();
	registry.register(fetchUrlTool);
	registry.register(createRememberTool());
	if (env.KAGI_KEY) {
		registry.register(createWebSearchTool(new KagiSearchBackend(env.KAGI_KEY)));
	}
	if (env.YNAB_TOKEN) {
		for (const tool of createYnabTools(env.YNAB_TOKEN)) {
			registry.register(tool);
		}
	}
	if (env.OPENWEATHERMAP_KEY) {
		for (const tool of createOpenWeatherMapTools(env.OPENWEATHERMAP_KEY)) {
			registry.register(tool);
		}
	}
	// Use `allSettled` rather than `all` so one bad MCP server doesn't take
	// down sibling registrations. Log each rejection so operators can see why
	// a tool is missing (`Promise.all` + bare catch swallowed everything).
	const mcpResults = await Promise.allSettled(
		mcpServers
			.filter((s) => s.enabled && (s.transport === 'http' || s.transport === 'sse') && s.url)
			.map(async (s) => {
				try {
					await registerMcpServerTools(env, mcpCache, registry, s);
				} catch (e) {
					console.warn(
						`MCP server ${s.id} (${s.name}) tool registration failed:`,
						e instanceof Error ? e.message : String(e),
					);
					throw e;
				}
			}),
	);
	// Defensive: surface any settled errors not already logged.
	for (const r of mcpResults) {
		if (r.status === 'rejected' && r.reason instanceof Error && !r.reason.message) {
			console.warn('MCP server registration rejected without a message');
		}
	}
	if (env.SANDBOX) {
		registerSandboxTools(registry, {
			...(getModels ? { loadImage: { getModels } } : {}),
		});
	}
	if (env.RUN_JS_LOADER) {
		registry.register(runJsTool);
		// Custom tools run in `RUN_JS_LOADER` isolates, and the meta tools let
		// the agent author them. Both require the loader binding.
		for (const row of customTools.filter((t) => t.enabled)) {
			try {
				registry.register(buildCustomTool(row));
			} catch (e) {
				// One bad tool definition shouldn't take down the whole turn,
				// but log so operators can diagnose a malformed schema.
				console.warn(
					`Custom tool ${row.id} (${row.name}) build failed:`,
					e instanceof Error ? e.message : String(e),
				);
			}
		}
		for (const tool of customToolMetaTools) {
			registry.register(tool);
		}
	}
	return registry;
}

export async function buildToolRegistry(env: Env, mcpCache: McpCache, model: string, context: ConversationContext): Promise<ToolRegistry> {
	const getModels = () => context.allModels;
	const registry = await buildBaseToolRegistry(env, mcpCache, context.mcpServers, context.customTools, getModels);
	const globalIds = context.allModels.map((m) => buildGlobalModelId(m.providerId, m.id));
	if (globalIds.length > 0) {
		// `switch_model`'s description tells the model to call `get_models`
		// first, so the two ship together. `get_models` is also used by the
		// `agent` tool flow when sub-agents are enabled.
		registry.register(createSwitchModelTool({ availableModelGlobalIds: globalIds }));
		registry.register(createGetModelsTool({ currentModel: model, availableModels: context.allModels }));
	}
	const enabledSubAgents = context.subAgents.filter((sa) => sa.enabled);
	if (enabledSubAgents.length > 0) {
		const agentTool = createAgentTool(
			{
				buildInnerToolRegistry: () =>
					buildBaseToolRegistry(env, mcpCache, context.mcpServers, context.customTools, getModels),
				defaultModel: model,
				availableModelGlobalIds: globalIds,
			},
			context.subAgents,
		);
		if (agentTool) registry.register(agentTool);
	}
	return registry;
}

async function registerMcpServerTools(env: Env, mcpCache: McpCache, registry: ToolRegistry, server: McpServerRow): Promise<void> {
	const serverId = server.id;
	const serverName = server.name;
	const url = server.url!;
	const authJson = server.authJson;
	// Token resolver: re-reads the OAuth row each call so a refresh from
	// another tool turn is visible. `force` ignores the row's expiry by
	// pretending it just expired — used to recover from a 401.
	const getAccessToken = server.oauth
		? async ({ force = false }: { force?: boolean } = {}) => {
				const fresh = await getMcpServer(env, serverId);
				if (!fresh?.oauth) return null;
				const oauthState = force ? { ...fresh.oauth, expiresAt: 0 } : fresh.oauth;
				return getValidAccessToken(env, serverId, oauthState);
			}
		: undefined;
	try {
		const cached = mcpCache.get(serverId);
		const fresh = cached && nowMs() - cached.fetchedAt < MCP_TOOL_CACHE_TTL_MS;
		let entry: McpCacheEntry;
		if (fresh && cached) {
			entry = cached;
		} else {
			const client = new McpHttpClient({ url, authJson, getAccessToken });
			const tools = await client.listTools();
			entry = { fetchedAt: nowMs(), client, tools };
			mcpCache.set(serverId, entry);
		}
		const callClient = entry.client;
		for (const tool of entry.tools) {
			const namespacedName = `mcp_${serverId}_${tool.name}`;
			registry.register({
				definition: {
					name: namespacedName,
					description: tool.description ?? `${serverName}: ${tool.name}`,
					inputSchema: tool.inputSchema ?? { type: 'object' },
				},
				async execute(_ctx, input) {
					try {
						const result = await callClient.callTool(tool.name, input);
						const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
						return { content: text, ...(result.isError ? { isError: true } : {}) };
					} catch (e) {
						return { content: e instanceof Error ? e.message : String(e), isError: true };
					}
				},
			});
		}
	} catch {
		// Server unreachable during enumeration — skip and try again next turn.
		mcpCache.delete(serverId);
	}
}
