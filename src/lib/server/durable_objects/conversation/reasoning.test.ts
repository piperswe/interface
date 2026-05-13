import { describe, expect, it } from 'vitest';
import { budgetToEffort, resolveReasoningConfig } from './reasoning';

describe('budgetToEffort', () => {
	it('returns null for zero or negative', () => {
		expect(budgetToEffort(0)).toBeNull();
		expect(budgetToEffort(-1)).toBeNull();
	});
	it('maps ranges to effort strings', () => {
		expect(budgetToEffort(1024)).toBe('low');
		expect(budgetToEffort(4096)).toBe('medium');
		expect(budgetToEffort(16384)).toBe('high');
		expect(budgetToEffort(32768)).toBe('xhigh');
		expect(budgetToEffort(99999)).toBe('xhigh');
	});
});

describe('resolveReasoningConfig', () => {
	describe('native Anthropic thinking-capable models (providerType=anthropic, reasoningType!=null)', () => {
		it('returns enabled thinking when budget > 0', () => {
			expect(resolveReasoningConfig({ providerType: 'anthropic', reasoningType: 'max_tokens', thinkingBudget: 4096 })).toEqual({
				thinking: { budgetTokens: 4096, type: 'enabled' },
			});
		});

		it('returns disabled thinking when budget is null', () => {
			// Regression: returning {} here means the `thinking` param is omitted,
			// which relies on the API default instead of being explicit. For
			// thinking-capable models we must send { type: 'disabled' } so the
			// intent is unambiguous.
			expect(resolveReasoningConfig({ providerType: 'anthropic', reasoningType: 'max_tokens', thinkingBudget: null })).toEqual({
				thinking: { type: 'disabled' },
			});
		});

		it('returns disabled thinking when budget is 0', () => {
			expect(resolveReasoningConfig({ providerType: 'anthropic', reasoningType: 'max_tokens', thinkingBudget: 0 })).toEqual({
				thinking: { type: 'disabled' },
			});
		});
	});

	describe('native Anthropic models without thinking (reasoningType=null)', () => {
		it('returns {} when budget is null', () => {
			expect(resolveReasoningConfig({ providerType: 'anthropic', reasoningType: null, thinkingBudget: null })).toEqual({});
		});
	});

	describe('effort-based reasoning (e.g. OpenAI, Kimi K2.6)', () => {
		it('returns reasoning effort when budget > 0', () => {
			expect(resolveReasoningConfig({ providerType: 'openai', reasoningType: 'effort', thinkingBudget: 4096 })).toEqual({
				reasoning: { effort: 'medium', type: 'effort' },
			});
		});

		it('returns effort:none when budget is null', () => {
			// Regression: we were returning {} here, which omits reasoning_effort.
			// Some models (e.g. Kimi K2.6 via Cloudflare AI Gateway) default to
			// reasoning ON when the param is absent, so we must send an explicit
			// 'none' to actually disable it.
			expect(resolveReasoningConfig({ providerType: 'openai', reasoningType: 'effort', thinkingBudget: null })).toEqual({
				reasoning: { effort: 'none', type: 'effort' },
			});
		});

		it('returns effort:none when budget is 0', () => {
			expect(resolveReasoningConfig({ providerType: 'openai', reasoningType: 'effort', thinkingBudget: 0 })).toEqual({
				reasoning: { effort: 'none', type: 'effort' },
			});
		});
	});

	describe('max_tokens reasoning (e.g. OpenRouter, non-native Anthropic)', () => {
		it('returns reasoning max_tokens when budget > 0', () => {
			expect(resolveReasoningConfig({ providerType: 'openrouter', reasoningType: 'max_tokens', thinkingBudget: 8192 })).toEqual({
				reasoning: { maxTokens: 8192, type: 'max_tokens' },
			});
		});

		it('returns {} when budget is null', () => {
			expect(resolveReasoningConfig({ providerType: 'openrouter', reasoningType: 'max_tokens', thinkingBudget: null })).toEqual({});
		});
	});

	it('returns {} when reasoningType is null and provider is not anthropic', () => {
		expect(resolveReasoningConfig({ providerType: null, reasoningType: null, thinkingBudget: null })).toEqual({});
		expect(resolveReasoningConfig({ providerType: null, reasoningType: null, thinkingBudget: 1024 })).toEqual({});
	});
});
