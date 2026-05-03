import { error } from '@sveltejs/kit';
import { listMcpServers } from '$lib/server/mcp_servers';
import {
	describeProviderKeys,
	getContextCompactionSummaryTokens,
	getContextCompactionThreshold,
	getModelList,
	getSystemPrompt,
	getUserBio,
} from '$lib/server/settings';
import { DEFAULT_MODEL_LIST } from '$lib/server/models/config';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const env = platform.env;
	const [mcpServers, threshold, summaryTokens, modelList, systemPrompt, userBio] = await Promise.all([
		listMcpServers(env),
		getContextCompactionThreshold(env),
		getContextCompactionSummaryTokens(env),
		getModelList(env),
		getSystemPrompt(env),
		getUserBio(env),
	]);
	return {
		providerKeys: describeProviderKeys(env),
		mcpServers,
		contextCompactionThreshold: threshold,
		contextCompactionSummaryTokens: summaryTokens,
		modelList,
		defaultModelList: DEFAULT_MODEL_LIST,
		systemPrompt: systemPrompt ?? '',
		userBio: userBio ?? '',
	};
};
