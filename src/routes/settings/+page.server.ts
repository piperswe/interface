import { error } from '@sveltejs/kit';
import { listMcpServers } from '$lib/server/mcp_servers';
import {
	describeSecretKeys,
	getContextCompactionSummaryTokens,
	getContextCompactionThreshold,
	getKagiCostPer1000Searches,
	getSystemPrompt,
	getTtsVoice,
	getUserBio,
	getSetting,
} from '$lib/server/settings';
import { TTS_VOICES } from '$lib/server/tts';
import { listSubAgents } from '$lib/server/sub_agents';
import { listProviders } from '$lib/server/providers/store';
import { listAllModels } from '$lib/server/providers/models';
import { listMemories } from '$lib/server/memories';
import { listStyles } from '$lib/server/styles';
import { listTags } from '$lib/server/tags';
import { listSchedules } from '$lib/server/schedules';
import { listConversations } from '$lib/server/conversations';
import { PROVIDER_PRESETS } from '$lib/server/providers/presets';
import { MCP_SERVER_PRESETS } from '$lib/server/mcp/presets';
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
	]);
	return {
		secretKeys: describeSecretKeys(env),
		mcpServers,
		mcpPresets: MCP_SERVER_PRESETS,
		subAgents,
		providers,
		models: allModels,
		presets: PROVIDER_PRESETS,
		contextCompactionThreshold: threshold,
		contextCompactionSummaryTokens: summaryTokens,
		systemPrompt: systemPrompt ?? '',
		userBio: userBio ?? '',
		defaultModel: defaultModel ?? '',
		titleModel: titleModel ?? '',
		memories,
		styles,
		tags,
		schedules,
		conversations,
		kagiCostPer1000Searches,
		ttsVoice,
		ttsVoices: TTS_VOICES,
	};
};
