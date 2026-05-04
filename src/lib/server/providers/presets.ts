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
	id: 'openrouter',
	label: 'OpenRouter',
	type: 'openai_compatible',
	defaultEndpoint: 'https://openrouter.ai/api/v1',
	requiresApiKey: true,
	defaultModels: [], // fetched dynamically
	canFetchModels: true,
};

const AI_GATEWAY_PRESET: ProviderPreset = {
	id: 'ai-gateway',
	label: 'Cloudflare AI Gateway',
	type: 'openai_compatible',
	defaultEndpoint: 'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}',
	requiresApiKey: true,
	defaultModels: [
		{ id: 'workers-ai/@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', maxContextLength: 262_144, reasoningType: 'effort' },
		{ id: 'openai/gpt-5.5', name: 'GPT-5.5', maxContextLength: 1_000_000, reasoningType: 'effort' },
		{ id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', maxContextLength: 200_000, reasoningType: 'max_tokens' },
		{ id: 'anthropic/claude-opus-4-7', name: 'Claude Opus 4.7', maxContextLength: 1_000_000, reasoningType: 'max_tokens' },
		{ id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', maxContextLength: 1_000_000, reasoningType: 'max_tokens' },
		{ id: 'google-ai-studio/gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', maxContextLength: 1_000_000, reasoningType: 'max_tokens' },
		{
			id: 'google-ai-studio/gemini-3-flash-preview',
			name: 'Gemini 3 Flash Preview',
			maxContextLength: 1_000_000,
			reasoningType: 'max_tokens',
		},
		{ id: 'openrouter/deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', maxContextLength: 1_000_000, reasoningType: 'max_tokens' },
	],
	canFetchModels: false,
};

const WORKERS_AI_PRESET: ProviderPreset = {
	id: 'workers-ai',
	label: 'Cloudflare Workers AI',
	type: 'openai_compatible',
	defaultEndpoint: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
	requiresApiKey: true,
	defaultModels: [
		{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct (Fast)', maxContextLength: 131_072 },
		{ id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', maxContextLength: 256_000 },
		{ id: '@cf/meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct', maxContextLength: 131_072 },
		{ id: '@cf/mistral/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B', maxContextLength: 128_000 },
		{ id: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen3 30B A3B FP8', maxContextLength: 128_000 },
		{ id: '@cf/qwen/qwq-32b', name: 'Qwen QwQ 32B', maxContextLength: 128_000 },
		{ id: '@cf/deepseek/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 Distill Qwen 32B', maxContextLength: 128_000 },
		{ id: '@cf/moonshotai/kimi-k2.5', name: 'Moonshot AI Kimi K2.5', maxContextLength: 256_000 },
		{ id: '@cf/openai/gpt-oss-120b', name: 'OpenAI GPT-OSS 120B', maxContextLength: 128_000 },
		{ id: '@cf/google/gemma-3-12b-it', name: 'Google Gemma 3 12B IT', maxContextLength: 128_000 },
	],
	canFetchModels: false,
};

export const PROVIDER_PRESETS: ProviderPreset[] = [OPENROUTER_PRESET, AI_GATEWAY_PRESET, WORKERS_AI_PRESET];

export function getPresetById(id: string): ProviderPreset | null {
	return PROVIDER_PRESETS.find((p) => p.id === id) ?? null;
}
