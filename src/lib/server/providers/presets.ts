// Curated model lists and preset definitions for quickly configuring providers.
//
// Presets:
//   - openrouter: OpenAI-compatible, fetches models from OpenRouter API
//   - ai-gateway: Cloudflare AI Gateway (OpenAI-compatible REST endpoint)
//   - workers-ai: Cloudflare Workers AI (OpenAI-compatible REST endpoint)

import type { ProviderType, ReasoningType } from './types';

export interface CuratedModel {
	id: string;
	name: string;
	description?: string;
	maxContextLength: number;
	reasoningType?: ReasoningType;
}

export interface ProviderPreset {
	id: string;
	label: string;
	type: ProviderType;
	defaultEndpoint?: string;
	requiresApiKey: boolean;
	defaultModels: CuratedModel[];
	canFetchModels: boolean;
}

const OPENROUTER_PRESET: ProviderPreset = {
	canFetchModels: true,
	defaultEndpoint: 'https://openrouter.ai/api/v1',
	defaultModels: [], // fetched dynamically
	id: 'openrouter',
	label: 'OpenRouter',
	requiresApiKey: true,
	type: 'openai_compatible',
};

const AI_GATEWAY_PRESET: ProviderPreset = {
	canFetchModels: false,
	defaultEndpoint: 'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}',
	defaultModels: [
		{ id: 'workers-ai/@cf/moonshotai/kimi-k2.6', maxContextLength: 262_144, name: 'Kimi K2.6', reasoningType: 'max_tokens' },
		{ id: 'openai/gpt-5.5', maxContextLength: 1_000_000, name: 'GPT-5.5', reasoningType: 'effort' },
		{ id: 'anthropic/claude-sonnet-4-6', maxContextLength: 200_000, name: 'Claude Sonnet 4.6', reasoningType: 'max_tokens' },
		{ id: 'anthropic/claude-opus-4-7', maxContextLength: 1_000_000, name: 'Claude Opus 4.7', reasoningType: 'max_tokens' },
		{ id: 'anthropic/claude-haiku-4-5', maxContextLength: 1_000_000, name: 'Claude Haiku 4.5', reasoningType: 'max_tokens' },
		{ id: 'google-ai-studio/gemini-3-pro-preview', maxContextLength: 1_000_000, name: 'Gemini 3 Pro Preview', reasoningType: 'effort' },
		{
			id: 'google-ai-studio/gemini-3-flash-preview',
			maxContextLength: 1_000_000,
			name: 'Gemini 3 Flash Preview',
			reasoningType: 'effort',
		},
		{ id: 'openrouter/deepseek/deepseek-v4-pro', maxContextLength: 1_000_000, name: 'DeepSeek V4 Pro', reasoningType: 'max_tokens' },
	],
	id: 'ai-gateway',
	label: 'Cloudflare AI Gateway',
	requiresApiKey: true,
	type: 'openai_compatible',
};

const WORKERS_AI_PRESET: ProviderPreset = {
	canFetchModels: false,
	defaultEndpoint: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
	defaultModels: [
		{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', maxContextLength: 131_072, name: 'Llama 3.3 70B Instruct (Fast)' },
		{ id: '@cf/meta/llama-4-scout-17b-16e-instruct', maxContextLength: 256_000, name: 'Llama 4 Scout 17B' },
		{ id: '@cf/meta/llama-3.1-8b-instruct', maxContextLength: 131_072, name: 'Llama 3.1 8B Instruct' },
		{ id: '@cf/mistral/mistral-small-3.1-24b-instruct', maxContextLength: 128_000, name: 'Mistral Small 3.1 24B' },
		{ id: '@cf/qwen/qwen3-30b-a3b-fp8', maxContextLength: 128_000, name: 'Qwen3 30B A3B FP8' },
		{ id: '@cf/qwen/qwq-32b', maxContextLength: 128_000, name: 'Qwen QwQ 32B' },
		{ id: '@cf/deepseek/deepseek-r1-distill-qwen-32b', maxContextLength: 128_000, name: 'DeepSeek R1 Distill Qwen 32B' },
		{ id: '@cf/moonshotai/kimi-k2.5', maxContextLength: 256_000, name: 'Moonshot AI Kimi K2.5' },
		{ id: '@cf/openai/gpt-oss-120b', maxContextLength: 128_000, name: 'OpenAI GPT-OSS 120B' },
		{ id: '@cf/google/gemma-3-12b-it', maxContextLength: 128_000, name: 'Google Gemma 3 12B IT' },
	],
	id: 'workers-ai',
	label: 'Cloudflare Workers AI',
	requiresApiKey: true,
	type: 'openai_compatible',
};

export const PROVIDER_PRESETS: ProviderPreset[] = [OPENROUTER_PRESET, AI_GATEWAY_PRESET, WORKERS_AI_PRESET];

export function getPresetById(id: string): ProviderPreset | null {
	return PROVIDER_PRESETS.find((p) => p.id === id) ?? null;
}
