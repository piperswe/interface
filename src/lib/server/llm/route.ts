import Anthropic from '@anthropic-ai/sdk';
import { OpenRouter } from '@openrouter/sdk';
import { AnthropicLLM } from './AnthropicLLM';
import type LLM from './LLM';
import { OpenRouterLLM } from './OpenRouterLLM';

// SDK clients keep an internal fetch agent; reusing them across chat turns
// preserves whatever connection caching the SDK does internally and avoids
// allocating a fresh adapter object per `routeLLM` call. Keyed by the API
// key string so that key rotation transparently picks up a fresh client.
const anthropicClients = new Map<string, Anthropic>();
const openrouterClients = new Map<string, OpenRouter>();

function anthropicFor(apiKey: string): Anthropic {
	let client = anthropicClients.get(apiKey);
	if (!client) {
		client = new Anthropic({ apiKey });
		anthropicClients.set(apiKey, client);
	}
	return client;
}

function openrouterFor(apiKey: string): OpenRouter {
	let client = openrouterClients.get(apiKey);
	if (!client) {
		client = new OpenRouter({
			apiKey,
			httpReferer: 'https://github.com/piperswe/interface',
			appTitle: 'Interface',
		});
		openrouterClients.set(apiKey, client);
	}
	return client;
}

// Resolves a model id to an LLM adapter. Picks a native provider adapter when:
//   - the model id matches that provider's bare-id form (e.g. "claude-…"), AND
//   - the corresponding provider key secret is configured.
// Otherwise falls through to OpenRouter (catch-all per PRD §5.1).
export function routeLLM(env: Env, model: string): LLM {
	if (isAnthropicModel(model) && env.ANTHROPIC_KEY) {
		return new AnthropicLLM(anthropicFor(env.ANTHROPIC_KEY), model, 'anthropic');
	}
	return new OpenRouterLLM(openrouterFor(env.OPENROUTER_KEY), model, 'openrouter');
}

// Bare Anthropic model id form. OpenRouter ids carry a vendor prefix
// (e.g. "anthropic/claude-…") and stay on OpenRouter even when ANTHROPIC_KEY
// is configured — the operator chose OpenRouter for that conversation.
export function isAnthropicModel(model: string): boolean {
	return model.startsWith('claude-');
}

// Test-only: clear the cached clients between cases.
export function _clearLLMClientCache(): void {
	anthropicClients.clear();
	openrouterClients.clear();
}
