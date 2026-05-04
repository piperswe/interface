import type { Provider, ProviderModel } from '../providers/types';
import { getResolvedModel } from '../providers/models';
import { AnthropicLLM } from './AnthropicLLM';
import { OpenAILLM, type OpenAILLMConfig } from './OpenAILLM';
import type LLM from './LLM';

// Route a resolved provider+model pair to the appropriate LLM adapter.
// Outside of this module, models are always referred to by their global ID
// `{provider_id}/{model_id}` and resolved via `getResolvedModel()` before
// being passed here.
export function routeLLM(provider: Provider, model: ProviderModel): LLM {
	switch (provider.type) {
		case 'anthropic': {
			if (!provider.apiKey) throw new Error(`Anthropic provider ${provider.id} missing API key`);
			return new AnthropicLLM(provider.apiKey, model.id, provider.id);
		}
		case 'openai_compatible': {
			if (!provider.apiKey) throw new Error(`Provider ${provider.id} missing API key`);
			const config: OpenAILLMConfig = {
				baseURL: provider.endpoint ?? 'https://api.openai.com/v1',
				apiKey: provider.apiKey,
				extraHeaders: {
					'HTTP-Referer': 'https://github.com/piperswe/interface',
					'X-Title': 'Interface',
				},
			};
			return new OpenAILLM(config, model.id, provider.id);
		}
		default: {
			// exhaustive check
			const _exhaustive: never = provider.type;
			throw new Error(`Unknown provider type: ${_exhaustive}`);
		}
	}
}

/** Resolve a global model ID and route to the appropriate adapter. */
export async function routeLLMByGlobalId(env: Env, globalId: string): Promise<LLM> {
	const resolved = await getResolvedModel(env, globalId);
	if (!resolved) throw new Error(`Unknown model: ${globalId}`);
	return routeLLM(resolved.provider, resolved.model);
}

// Convenience re-exports for consumers that already have a resolved model.
export { AnthropicLLM, OpenAILLM };
export type { OpenAILLMConfig };
