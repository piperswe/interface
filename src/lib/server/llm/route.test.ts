import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createProvider } from '../providers/store';
import { createModel } from '../providers/models';
import { routeLLM, routeLLMByGlobalId } from './route';
import { AnthropicLLM } from './AnthropicLLM';
import { OpenAILLM } from './OpenAILLM';

describe('routeLLM', () => {
	it('routes an OpenAI-compatible provider to OpenAILLM', async () => {
		await createProvider(env, {
			id: 'test-openai',
			type: 'openai_compatible',
			apiKey: 'sk-test',
			endpoint: 'https://api.openai.com/v1',
		});
		await createModel(env, 'test-openai', { id: 'gpt-4', name: 'GPT-4' });
		const llm = await routeLLMByGlobalId(env, 'test-openai/gpt-4');
		expect(llm).toBeInstanceOf(OpenAILLM);
		expect(llm.model).toBe('gpt-4');
		expect(llm.providerID).toBe('test-openai');
	});

	it('routes an Anthropic provider to AnthropicLLM', async () => {
		await createProvider(env, {
			id: 'test-anthropic',
			type: 'anthropic',
			apiKey: 'sk-ant-test',
		});
		await createModel(env, 'test-anthropic', { id: 'claude-sonnet-4', name: 'Claude Sonnet' });
		const llm = await routeLLMByGlobalId(env, 'test-anthropic/claude-sonnet-4');
		expect(llm).toBeInstanceOf(AnthropicLLM);
		expect(llm.providerID).toBe('test-anthropic');
	});

	it('throws for unknown model global IDs', async () => {
		await expect(routeLLMByGlobalId(env, 'unknown/model')).rejects.toThrow('Unknown model');
	});
});
