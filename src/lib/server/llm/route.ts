import Anthropic from '@anthropic-ai/sdk';
import { OpenRouter } from '@openrouter/sdk';
import OpenAI from 'openai';
import { AnthropicLLM } from './AnthropicLLM';
import { CloudflareWorkersAILLM } from './CloudflareWorkersAILLM';
import type LLM from './LLM';
import { OpenAILLM } from './OpenAILLM';
import { OpenRouterLLM } from './OpenRouterLLM';
import { getCloudflareAIGatewayId } from '../settings';

// SDK clients keep an internal fetch agent; reusing them across chat turns
// preserves whatever connection caching the SDK does internally and avoids
// allocating a fresh adapter object per `routeLLM` call. Keyed by the API
// key + base URL string so that key/baseURL rotation transparently picks up
// a fresh client and direct-vs-gateway-routed clients don't collide.
const anthropicClients = new Map<string, Anthropic>();
const openrouterClients = new Map<string, OpenRouter>();
const openaiClients = new Map<string, OpenAI>();

function clientKey(apiKey: string, baseURL: string | undefined, headerSig: string): string {
	return `${apiKey}|${baseURL ?? ''}|${headerSig}`;
}

function anthropicFor(apiKey: string, baseURL?: string, defaultHeaders?: Record<string, string>): Anthropic {
	const headerSig = defaultHeaders ? JSON.stringify(defaultHeaders) : '';
	const key = clientKey(apiKey, baseURL, headerSig);
	let client = anthropicClients.get(key);
	if (!client) {
		client = new Anthropic({
			apiKey,
			...(baseURL ? { baseURL } : {}),
			...(defaultHeaders ? { defaultHeaders } : {}),
		});
		anthropicClients.set(key, client);
	}
	return client;
}

function openrouterFor(apiKey: string): OpenRouter {
	const key = clientKey(apiKey, undefined, '');
	let client = openrouterClients.get(key);
	if (!client) {
		client = new OpenRouter({
			apiKey,
			httpReferer: 'https://github.com/piperswe/interface',
			appTitle: 'Interface',
		});
		openrouterClients.set(key, client);
	}
	return client;
}

function openaiFor(apiKey: string, baseURL?: string, defaultHeaders?: Record<string, string>): OpenAI {
	const headerSig = defaultHeaders ? JSON.stringify(defaultHeaders) : '';
	const key = clientKey(apiKey, baseURL, headerSig);
	let client = openaiClients.get(key);
	if (!client) {
		client = new OpenAI({
			apiKey,
			...(baseURL ? { baseURL } : {}),
			...(defaultHeaders ? { defaultHeaders } : {}),
		});
		openaiClients.set(key, client);
	}
	return client;
}

// Resolves a model id to an LLM adapter. Dispatch order:
//
//   1. `@cf/...` slugs always route to Workers AI via the `env.AI` binding.
//      If a Gateway slug is configured, the binding routes through it for
//      analytics/caching (Workers AI billing applies regardless).
//   2. With AI Gateway configured (`cf_ai_gateway_id` set), all third-party
//      traffic flows through the Gateway with Unified Billing / BYOK auth.
//      Provider-native endpoints are used for Anthropic, OpenAI, and DeepSeek;
//      the `/compat` Unified API is used as the catch-all.
//   3. Without AI Gateway: legacy behavior — native Anthropic when configured,
//      OpenRouter as the catch-all.
//
// Tests don't override this directly — they swap in a FakeLLM via the DO's
// `__setLLMOverride` RPC method, which crosses the isolate boundary that
// vitest-pool-workers maintains.
export async function routeLLM(env: Env, model: string): Promise<LLM> {
	const gatewayId = await getCloudflareAIGatewayId(env);

	if (model.startsWith('@cf/')) {
		return new CloudflareWorkersAILLM(env.AI, model, gatewayId);
	}

	if (gatewayId) {
		const aig = env.AI.gateway(gatewayId);
		const cfToken = env.CF_AI_GATEWAY_TOKEN ?? '';
		const cfHeaders = { 'cf-aig-authorization': `Bearer ${cfToken}` };

		if (isAnthropicModel(model)) {
			const baseURL = ensureString(aig.getUrl('anthropic'));
			return new AnthropicLLM(
				anthropicFor('cf-aig', await baseURL, cfHeaders),
				stripAnthropicPrefix(model),
				'anthropic-via-aig',
			);
		}
		if (isOpenAIBareModel(model)) {
			const baseURL = await ensureString(aig.getUrl('openai'));
			return new OpenAILLM(
				openaiFor('cf-aig', baseURL, cfHeaders),
				stripOpenAIPrefix(model),
				'openai-via-aig',
			);
		}
		if (isDeepSeekBareModel(model)) {
			const baseURL = await ensureString(aig.getUrl('deepseek'));
			return new OpenAILLM(
				openaiFor('cf-aig', baseURL, cfHeaders),
				stripDeepSeekPrefix(model),
				'deepseek-via-aig',
			);
		}
		// Catch-all: AI Gateway Unified API. Accepts the full provider/model
		// slug verbatim (e.g. "anthropic/claude-…", "google-ai-studio/gemini-…").
		const base = await ensureString(aig.getUrl());
		const compatBase = base.endsWith('/') ? `${base}compat` : `${base}/compat`;
		return new OpenAILLM(openaiFor('cf-aig', compatBase, cfHeaders), model, 'aig-unified');
	}

	// No gateway — direct provider clients with their own keys.
	if (isAnthropicModel(model) && env.ANTHROPIC_KEY) {
		return new AnthropicLLM(anthropicFor(env.ANTHROPIC_KEY), model, 'anthropic');
	}
	return new OpenRouterLLM(openrouterFor(env.OPENROUTER_KEY), model, 'openrouter');
}

// `Ai.gateway(id).getUrl(provider)` may return either a string or a
// Promise<string> depending on the runtime types version. Normalize.
async function ensureString(value: string | Promise<string>): Promise<string> {
	return typeof value === 'string' ? value : await value;
}

// Bare Anthropic model id form ("claude-...") OR vendor-prefixed
// "anthropic/claude-...". Both go through the native Anthropic SDK when
// routed through AI Gateway (the gateway endpoint expects bare ids — see
// `stripAnthropicPrefix`).
export function isAnthropicModel(model: string): boolean {
	return model.startsWith('claude-') || model.startsWith('anthropic/');
}

export function isOpenAIBareModel(model: string): boolean {
	if (model.startsWith('openai/')) return true;
	return /^(gpt-|o[1-9])/.test(model);
}

export function isDeepSeekBareModel(model: string): boolean {
	return model.startsWith('deepseek-') || model.startsWith('deepseek/');
}

export function stripAnthropicPrefix(model: string): string {
	return model.startsWith('anthropic/') ? model.slice('anthropic/'.length) : model;
}

export function stripOpenAIPrefix(model: string): string {
	return model.startsWith('openai/') ? model.slice('openai/'.length) : model;
}

export function stripDeepSeekPrefix(model: string): string {
	return model.startsWith('deepseek/') ? model.slice('deepseek/'.length) : model;
}

// Test-only: clear the cached clients between cases.
export function _clearLLMClientCache(): void {
	anthropicClients.clear();
	openrouterClients.clear();
	openaiClients.clear();
}
