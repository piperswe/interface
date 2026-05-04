import { error } from '@sveltejs/kit';
import { listMcpServers } from '$lib/server/mcp_servers';
import {
	describeSecretKeys,
	getContextCompactionSummaryTokens,
	getContextCompactionThreshold,
	getSystemPrompt,
	getUserBio,
	getSetting,
} from '$lib/server/settings';
import { listSubAgents } from '$lib/server/sub_agents';
import { listProviders } from '$lib/server/providers/store';
import { listAllModels } from '$lib/server/providers/models';
import { PROVIDER_PRESETS } from '$lib/server/providers/presets';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const env = platform.env;
	const [mcpServers, subAgents, providers, allModels, threshold, summaryTokens, systemPrompt, userBio, defaultModel] =
		await Promise.all([
			listMcpServers(env),
			listSubAgents(env),
			listProviders(env),
			listAllModels(env),
			getContextCompactionThreshold(env),
			getContextCompactionSummaryTokens(env),
			getSystemPrompt(env),
			getUserBio(env),
			getSetting(env, 'default_model'),
		]);
	return {
		secretKeys: describeSecretKeys(env),
		mcpServers,
		subAgents,
		providers,
		models: allModels,
		presets: PROVIDER_PRESETS,
		contextCompactionThreshold: threshold,
		contextCompactionSummaryTokens: summaryTokens,
		systemPrompt: systemPrompt ?? '',
		userBio: userBio ?? '',
		defaultModel: defaultModel ?? '',
	};
};
