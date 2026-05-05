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
import { buildGlobalModelId } from '../../providers/types';
import type { McpServerRow, McpToolDescriptor } from '../../mcp/types';
import type { ProviderModel } from '../../providers/types';
import type { SubAgentRow } from '../../sub_agents';
import type { MemoryRow } from '../../memories';
import type { StyleRow } from '../../styles';
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
};

// Base registry — built-in tools + MCP. Used directly for the parent
// loop (extended in `buildToolRegistry` with the `agent` tool) and re-built
// fresh per sub-agent invocation as the inner tool set.
export async function buildBaseToolRegistry(
	env: Env,
	mcpCache: McpCache,
	mcpServers: McpServerRow[],
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
	try {
		await Promise.all(
			mcpServers
				.filter((s) => s.enabled && (s.transport === 'http' || s.transport === 'sse') && s.url)
				.map((s) => registerMcpServerTools(env, mcpCache, registry, s)),
		);
	} catch {
		// MCP enumeration failures are best-effort.
	}
	if (env.SANDBOX) {
		registerSandboxTools(registry);
	}
	if (env.RUN_JS_LOADER) {
		registry.register(runJsTool);
	}
	return registry;
}

export async function buildToolRegistry(
	env: Env,
	mcpCache: McpCache,
	model: string,
	context: ConversationContext,
): Promise<ToolRegistry> {
	const registry = await buildBaseToolRegistry(env, mcpCache, context.mcpServers);
	const globalIds = context.allModels.map((m) => buildGlobalModelId(m.providerId, m.id));
	if (globalIds.length > 0) {
		registry.register(createSwitchModelTool({ availableModelGlobalIds: globalIds }));
	}
	const enabledSubAgents = context.subAgents.filter((sa) => sa.enabled);
	if (enabledSubAgents.length > 0) {
		registry.register(createGetModelsTool({ currentModel: model, availableModels: context.allModels }));
		const agentTool = createAgentTool(
			{
				buildInnerToolRegistry: () => buildBaseToolRegistry(env, mcpCache, context.mcpServers),
				defaultModel: model,
				availableModelGlobalIds: globalIds,
			},
			context.subAgents,
		);
		if (agentTool) registry.register(agentTool);
	}
	return registry;
}

async function registerMcpServerTools(
	env: Env,
	mcpCache: McpCache,
	registry: ToolRegistry,
	server: McpServerRow,
): Promise<void> {
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
