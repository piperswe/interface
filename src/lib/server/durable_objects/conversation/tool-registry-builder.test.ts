import { describe, expect, it } from 'vitest';
import { buildToolRegistry, type ConversationContext, type McpCache } from './tool-registry-builder';
import type { ProviderModel } from '../../providers/types';

// Regression coverage for `buildToolRegistry`. The registry's job is to
// expose the right tool set for a turn given the current model + context.
//
// Specifically, this guards against the bug where `get_models` was only
// registered alongside the `agent` tool (gated on enabled sub-agents), but
// `switch_model` (gated only on having ≥1 model) referenced `get_models`
// in its description. Without sub-agents the model would call a non-existent
// tool.

function makeModel(providerId: string, id: string): ProviderModel {
	return {
		id,
		providerId,
		name: id,
		description: null,
		maxContextLength: 128_000,
		reasoningType: null,
		inputCostPerMillionTokens: null,
		outputCostPerMillionTokens: null,
		supportsImageInput: false,
		sortOrder: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function makeContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
	return {
		systemPrompt: null,
		userBio: null,
		allModels: [],
		subAgents: [],
		mcpServers: [],
		memories: [],
		styles: [],
		...overrides,
	};
}

const emptyEnv = {} as Env;
const emptyCache: McpCache = new Map();

describe('buildToolRegistry', () => {
	it('does not register switch_model or get_models when no models are configured', async () => {
		const registry = await buildToolRegistry(emptyEnv, emptyCache, 'fake/m', makeContext());
		expect(registry.has('switch_model')).toBe(false);
		expect(registry.has('get_models')).toBe(false);
	});

	it('registers BOTH switch_model and get_models whenever any model is configured', async () => {
		// The defining regression: switch_model used to ship without get_models
		// when sub-agents weren't enabled, even though its description told
		// the model to "Call `get_models` first".
		const registry = await buildToolRegistry(emptyEnv, emptyCache, 'p/m', makeContext({ allModels: [makeModel('p', 'm')] }));
		expect(registry.has('switch_model')).toBe(true);
		expect(registry.has('get_models')).toBe(true);
	});

	it('still registers get_models when sub-agents are present (agent flow uses it too)', async () => {
		const registry = await buildToolRegistry(
			emptyEnv,
			emptyCache,
			'p/m',
			makeContext({
				allModels: [makeModel('p', 'm')],
				subAgents: [
					{
						id: 1,
						name: 'researcher',
						description: 'researches stuff',
						systemPrompt: 'be thorough',
						model: null,
						maxIterations: null,
						allowedTools: null,
						enabled: true,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			}),
		);
		expect(registry.has('get_models')).toBe(true);
		expect(registry.has('agent')).toBe(true);
	});

	it('does not register the agent tool when sub-agents are all disabled', async () => {
		const registry = await buildToolRegistry(
			emptyEnv,
			emptyCache,
			'p/m',
			makeContext({
				allModels: [makeModel('p', 'm')],
				subAgents: [
					{
						id: 1,
						name: 'researcher',
						description: 'researches stuff',
						systemPrompt: 'be thorough',
						model: null,
						maxIterations: null,
						allowedTools: null,
						enabled: false,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			}),
		);
		expect(registry.has('agent')).toBe(false);
	});
});
