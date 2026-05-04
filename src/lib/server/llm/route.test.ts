import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicLLM } from './AnthropicLLM';
import { CloudflareWorkersAILLM } from './CloudflareWorkersAILLM';
import { OpenAILLM } from './OpenAILLM';
import {
	_clearLLMClientCache,
	isAnthropicModel,
	isDeepSeekBareModel,
	isOpenAIBareModel,
	routeLLM,
	stripAnthropicPrefix,
	stripDeepSeekPrefix,
	stripOpenAIPrefix,
} from './route';
import { OpenRouterLLM } from './OpenRouterLLM';
import { setSetting, deleteSetting } from '../settings';

// Stub `env.AI` so gateway-routed dispatch can construct adapters and clients
// without touching real Cloudflare bindings.
function withStubAI(target: Env): Env {
	const fakeGateway = {
		getUrl(provider?: string) {
			const base = 'https://gateway.ai.cloudflare.com/v1/acct/gw/';
			return provider ? `${base}${provider}` : base;
		},
	};
	const fakeAI = {
		gateway: () => fakeGateway,
		run: async () => new ReadableStream<Uint8Array>(),
	};
	return { ...target, AI: fakeAI as unknown as Ai } as Env;
}

describe('routeLLM', () => {
	afterEach(async () => {
		_clearLLMClientCache();
		try {
			await deleteSetting(env, 'cf_ai_gateway_id');
		} catch {
			// ignore — table may not exist in all test envs
		}
	});

	describe('without AI Gateway', () => {
		it('returns an OpenRouterLLM for vendor-prefixed model ids', async () => {
			const llm = await routeLLM(env, 'moonshotai/kimi-k2');
			expect(llm).toBeInstanceOf(OpenRouterLLM);
			expect(llm.model).toBe('moonshotai/kimi-k2');
			expect(llm.providerID).toBe('openrouter');
		});

		it('returns an OpenRouterLLM for bare claude-* ids when ANTHROPIC_KEY is unset', async () => {
			const llm = await routeLLM(env, 'claude-sonnet-4-5');
			expect(llm).toBeInstanceOf(OpenRouterLLM);
		});

		it('returns an AnthropicLLM for bare claude-* ids when ANTHROPIC_KEY is set', async () => {
			const envWithAnthropic = { ...env, ANTHROPIC_KEY: 'sk-ant-test' } as unknown as Env;
			const llm = await routeLLM(envWithAnthropic, 'claude-sonnet-4-5');
			expect(llm).toBeInstanceOf(AnthropicLLM);
			expect(llm.providerID).toBe('anthropic');
		});

		it('produces independent adapter instances per call', async () => {
			const a = await routeLLM(env, 'm1');
			const b = await routeLLM(env, 'm2');
			expect(a).not.toBe(b);
			expect(a.model).toBe('m1');
			expect(b.model).toBe('m2');
		});
	});

	describe('Cloudflare Workers AI', () => {
		it('routes @cf/* slugs to CloudflareWorkersAILLM with no gateway when none is configured', async () => {
			const stubbed = withStubAI(env);
			const llm = await routeLLM(stubbed, '@cf/openai/gpt-oss-120b');
			expect(llm).toBeInstanceOf(CloudflareWorkersAILLM);
			expect(llm.model).toBe('@cf/openai/gpt-oss-120b');
		});
	});

	describe('with AI Gateway configured', () => {
		beforeEach(async () => {
			await setSetting(env, 'cf_ai_gateway_id', 'my-gw');
		});

		it('routes @cf/* via the binding even when gateway is set', async () => {
			const stubbed = withStubAI(env);
			const llm = await routeLLM(stubbed, '@cf/openai/gpt-oss-120b');
			expect(llm).toBeInstanceOf(CloudflareWorkersAILLM);
		});

		it('routes Anthropic models via AnthropicLLM with bare slug', async () => {
			const stubbed = withStubAI(env);
			const llm = await routeLLM(stubbed, 'anthropic/claude-sonnet-4.6');
			expect(llm).toBeInstanceOf(AnthropicLLM);
			expect(llm.model).toBe('claude-sonnet-4.6');
			expect(llm.providerID).toBe('anthropic-via-aig');
		});

		it('routes OpenAI models via OpenAILLM with bare slug', async () => {
			const stubbed = withStubAI(env);
			const llm = await routeLLM(stubbed, 'openai/gpt-5.5');
			expect(llm).toBeInstanceOf(OpenAILLM);
			expect(llm.model).toBe('gpt-5.5');
			expect(llm.providerID).toBe('openai-via-aig');
		});

		it('routes DeepSeek models via OpenAILLM with bare slug', async () => {
			const stubbed = withStubAI(env);
			const llm = await routeLLM(stubbed, 'deepseek/deepseek-chat');
			expect(llm).toBeInstanceOf(OpenAILLM);
			expect(llm.model).toBe('deepseek-chat');
			expect(llm.providerID).toBe('deepseek-via-aig');
		});

		it('routes anything else through OpenAILLM Unified API catch-all', async () => {
			const stubbed = withStubAI(env);
			const llm = await routeLLM(stubbed, 'google-ai-studio/gemini-2.5-pro');
			expect(llm).toBeInstanceOf(OpenAILLM);
			expect(llm.model).toBe('google-ai-studio/gemini-2.5-pro');
			expect(llm.providerID).toBe('aig-unified');
		});
	});

	it('isAnthropicModel matches bare claude-* and anthropic/-prefixed ids', () => {
		expect(isAnthropicModel('claude-sonnet-4-5')).toBe(true);
		expect(isAnthropicModel('anthropic/claude-sonnet-4')).toBe(true);
		expect(isAnthropicModel('gpt-4')).toBe(false);
	});

	it('isOpenAIBareModel matches gpt-* / o[1-9]* / openai/ prefix', () => {
		expect(isOpenAIBareModel('gpt-5.5')).toBe(true);
		expect(isOpenAIBareModel('o1-mini')).toBe(true);
		expect(isOpenAIBareModel('openai/gpt-5.5')).toBe(true);
		expect(isOpenAIBareModel('anthropic/claude-sonnet-4')).toBe(false);
		expect(isOpenAIBareModel('deepseek-chat')).toBe(false);
	});

	it('isDeepSeekBareModel matches deepseek-* and deepseek/ prefix', () => {
		expect(isDeepSeekBareModel('deepseek-chat')).toBe(true);
		expect(isDeepSeekBareModel('deepseek/deepseek-coder')).toBe(true);
		expect(isDeepSeekBareModel('gpt-5.5')).toBe(false);
	});

	it('strip helpers remove only the matching vendor prefix', () => {
		expect(stripAnthropicPrefix('anthropic/claude-foo')).toBe('claude-foo');
		expect(stripAnthropicPrefix('claude-foo')).toBe('claude-foo');
		expect(stripOpenAIPrefix('openai/gpt-5.5')).toBe('gpt-5.5');
		expect(stripDeepSeekPrefix('deepseek/deepseek-chat')).toBe('deepseek-chat');
	});
});
