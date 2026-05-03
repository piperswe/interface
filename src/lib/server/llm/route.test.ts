import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AnthropicLLM } from './AnthropicLLM';
import { isAnthropicModel, routeLLM } from './route';
import { OpenRouterLLM } from './OpenRouterLLM';

describe('routeLLM', () => {
	it('returns an OpenRouterLLM for vendor-prefixed model ids', () => {
		const llm = routeLLM(env, 'anthropic/claude-sonnet-4');
		expect(llm).toBeInstanceOf(OpenRouterLLM);
		expect(llm.model).toBe('anthropic/claude-sonnet-4');
		expect(llm.providerID).toBe('openrouter');
	});

	it('returns an OpenRouterLLM for bare claude-* ids when ANTHROPIC_KEY is unset', () => {
		const llm = routeLLM(env, 'claude-sonnet-4-5');
		// ANTHROPIC_KEY is not configured in the test env (only seeded OPENROUTER_KEY).
		expect(llm).toBeInstanceOf(OpenRouterLLM);
	});

	it('returns an AnthropicLLM for bare claude-* ids when ANTHROPIC_KEY is set', () => {
		const envWithAnthropic = { ...env, ANTHROPIC_KEY: 'sk-ant-test' } as unknown as Env;
		const llm = routeLLM(envWithAnthropic, 'claude-sonnet-4-5');
		expect(llm).toBeInstanceOf(AnthropicLLM);
		expect(llm.providerID).toBe('anthropic');
	});

	it('produces independent adapter instances per call', () => {
		const a = routeLLM(env, 'm1');
		const b = routeLLM(env, 'm2');
		expect(a).not.toBe(b);
		expect(a.model).toBe('m1');
		expect(b.model).toBe('m2');
	});

	it('isAnthropicModel matches bare claude-* ids only', () => {
		expect(isAnthropicModel('claude-sonnet-4-5')).toBe(true);
		expect(isAnthropicModel('claude-opus-4-1-20250805')).toBe(true);
		expect(isAnthropicModel('anthropic/claude-sonnet-4')).toBe(false);
		expect(isAnthropicModel('gpt-4')).toBe(false);
	});
});
