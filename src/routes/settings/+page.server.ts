import { error } from '@sveltejs/kit';
import { listConversations } from '$lib/server/conversations';
import { listCustomTools } from '$lib/server/custom_tools';
import { MCP_SERVER_PRESETS } from '$lib/server/mcp/presets';
import { listMcpServers } from '$lib/server/mcp_servers';
import { listMemories } from '$lib/server/memories';
import { listAllModels } from '$lib/server/providers/models';
import { PROVIDER_PRESETS } from '$lib/server/providers/presets';
import { listProviders } from '$lib/server/providers/store';
import { listBackends } from '$lib/server/sandbox';
import { listSchedules } from '$lib/server/schedules';
import {
	describeSecretKeys,
	getContextCompactionSummaryTokens,
	getContextCompactionThreshold,
	getKagiCostPer1000Searches,
	getSandboxBackendId,
	getSetting,
	getSystemPrompt,
	getTtsVoice,
	getUserBio,
	getWorkspaceIoMode,
} from '$lib/server/settings';
import { listStyles } from '$lib/server/styles';
import { listSubAgents } from '$lib/server/sub_agents';
import { listTags } from '$lib/server/tags';
import { TTS_VOICES } from '$lib/server/tts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const env = platform.env;
	const [
		mcpServers,
		subAgents,
		providers,
		allModels,
		threshold,
		summaryTokens,
		systemPrompt,
		userBio,
		defaultModel,
		titleModel,
		memories,
		styles,
		tags,
		schedules,
		conversations,
		kagiCostPer1000Searches,
		ttsVoice,
		workspaceIoMode,
		sandboxBackend,
		customTools,
	] = await Promise.all([
		listMcpServers(env),
		listSubAgents(env),
		listProviders(env),
		listAllModels(env),
		getContextCompactionThreshold(env),
		getContextCompactionSummaryTokens(env),
		getSystemPrompt(env),
		getUserBio(env),
		getSetting(env, 'default_model'),
		getSetting(env, 'title_model'),
		listMemories(env),
		listStyles(env),
		listTags(env),
		listSchedules(env),
		listConversations(env),
		getKagiCostPer1000Searches(env),
		getTtsVoice(env),
		getWorkspaceIoMode(env),
		getSandboxBackendId(env),
		listCustomTools(env),
	]);
	const sandboxBackends = listBackends().map((b) => ({
		available: b.isAvailable(env),
		id: b.id,
	}));
	return {
		contextCompactionSummaryTokens: summaryTokens,
		contextCompactionThreshold: threshold,
		conversations,
		customTools,
		defaultModel: defaultModel ?? '',
		hasWorkerLoader: !!env.RUN_JS_LOADER,
		kagiCostPer1000Searches,
		mcpPresets: MCP_SERVER_PRESETS,
		mcpServers,
		memories,
		models: allModels,
		presets: PROVIDER_PRESETS,
		providers,
		sandboxBackend,
		sandboxBackends,
		schedules,
		secretKeys: describeSecretKeys(env),
		styles,
		subAgents,
		systemPrompt: systemPrompt ?? '',
		tags,
		titleModel: titleModel ?? '',
		ttsVoice,
		ttsVoices: TTS_VOICES,
		userBio: userBio ?? '',
		workspaceIoMode,
	};
};
