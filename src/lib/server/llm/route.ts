import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Provider, ProviderModel } from '../providers/types';
import { getResolvedModel } from '../providers/models';
import { AnthropicLLM } from './AnthropicLLM';
import { OpenAILLM, type OpenAILLMConfig } from './OpenAILLM';
import type LLM from './LLM';

// Module-scope SDK client cache. The `Anthropic` / `OpenAI` SDK clients
// maintain a `fetch` agent and connection pool; reconstructing one per chat
// turn defeats that. Cached per-provider, keyed by a fingerprint of the
// connection-relevant config so a settings save (api key change, endpoint
// change) naturally cycles the cached client.
type AnthropicEntry = { fingerprint: string; client: Anthropic };
type OpenAIEntry = { fingerprint: string; client: OpenAI };
const anthropicClients = new Map<string, AnthropicEntry>();
const openaiClients = new Map<string, OpenAIEntry>();

function fingerprint(parts: (string | null | undefined)[]): string {
	return parts.map((p) => p ?? '').join('');
}

function getAnthropicClient(provider: Provider): Anthropic {
	if (!provider.apiKey) throw new Error(`Anthropic provider ${provider.id} missing API key`);
	const fp = fingerprint([provider.apiKey]);
	const cached = anthropicClients.get(provider.id);
	if (cached && cached.fingerprint === fp) return cached.client;
	const client = new Anthropic({ apiKey: provider.apiKey });
	anthropicClients.set(provider.id, { fingerprint: fp, client });
	return client;
}

const OPENAI_EXTRA_HEADERS = {
	'HTTP-Referer': 'https://github.com/piperswe/interface',
	'X-Title': 'Interface',
};

function getOpenAIClient(provider: Provider, baseURL: string): OpenAI {
	if (!provider.apiKey) throw new Error(`Provider ${provider.id} missing API key`);
	const fp = fingerprint([provider.apiKey, baseURL]);
	const cached = openaiClients.get(provider.id);
	if (cached && cached.fingerprint === fp) return cached.client;
	const client = new OpenAI({
		baseURL,
		apiKey: provider.apiKey,
		dangerouslyAllowBrowser: true,
		defaultHeaders: OPENAI_EXTRA_HEADERS,
	});
	openaiClients.set(provider.id, { fingerprint: fp, client });
	return client;
}

// Route a resolved provider+model pair to the appropriate LLM adapter.
// Outside of this module, models are always referred to by their global ID
// `{provider_id}/{model_id}` and resolved via `getResolvedModel()` before
// being passed here.
export function routeLLM(provider: Provider, model: ProviderModel): LLM {
	switch (provider.type) {
		case 'anthropic': {
			return new AnthropicLLM(getAnthropicClient(provider), model.id, provider.id);
		}
		case 'openai_compatible': {
			const baseURL = provider.endpoint ?? 'https://api.openai.com/v1';
			return new OpenAILLM(getOpenAIClient(provider, baseURL), model.id, provider.id);
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

/** Test seam: drop the cached SDK clients. Used by integration tests. */
export function _resetClientCache(): void {
	anthropicClients.clear();
	openaiClients.clear();
}

// Convenience re-exports for consumers that already have a resolved model.
export { AnthropicLLM, OpenAILLM };
export type { OpenAILLMConfig };
