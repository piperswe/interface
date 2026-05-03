import Anthropic from '@anthropic-ai/sdk';
import { OpenRouter } from '@openrouter/sdk';
import { AnthropicLLM } from './AnthropicLLM';
import type LLM from './LLM';
import { OpenRouterLLM } from './OpenRouterLLM';

// Resolves a model id to an LLM adapter. Picks a native provider adapter when:
//   - the model id matches that provider's bare-id form (e.g. "claude-…"), AND
//   - the corresponding provider key secret is configured.
// Otherwise falls through to OpenRouter (catch-all per PRD §5.1).
export function routeLLM(env: Env, model: string): LLM {
	if (isAnthropicModel(model) && env.ANTHROPIC_KEY) {
		return new AnthropicLLM(new Anthropic({ apiKey: env.ANTHROPIC_KEY }), model, 'anthropic');
	}
	return new OpenRouterLLM(
		new OpenRouter({
			apiKey: env.OPENROUTER_KEY,
			httpReferer: 'https://github.com/piperswe/interface',
			appTitle: 'Interface',
		}),
		model,
		'openrouter',
	);
}

// Bare Anthropic model id form. OpenRouter ids carry a vendor prefix
// (e.g. "anthropic/claude-…") and stay on OpenRouter even when ANTHROPIC_KEY
// is configured — the operator chose OpenRouter for that conversation.
export function isAnthropicModel(model: string): boolean {
	return model.startsWith('claude-');
}
