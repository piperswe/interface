import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModelsDevCatalog, type ModelsDevEntry, mapToCreateModelInput, resolveReasoning } from './modelsDev';

afterEach(() => {
	vi.restoreAllMocks();
});

function mockOnce(body: unknown, init?: ResponseInit) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(typeof body === 'string' ? body : JSON.stringify(body), init));
}

const ANTHROPIC_MODEL = {
	attachment: true,
	cost: { input: 3, output: 15 },
	id: 'claude-opus-4-6',
	knowledge: '2025-03-31',
	limit: { context: 200_000, output: 64_000 },
	modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
	name: 'Claude Opus 4',
	open_weights: false,
	reasoning: true,
	release_date: '2025-05-22',
	tool_call: true,
};

const OPENAI_MODEL = {
	attachment: false,
	cost: { input: 1.25, output: 10 },
	id: 'gpt-5',
	limit: { context: 400_000, output: 64_000 },
	modalities: { input: ['text'], output: ['text'] },
	name: 'GPT-5',
	open_weights: false,
	reasoning: true,
	release_date: '2025-08-01',
	tool_call: true,
};

function fixtureCatalog() {
	return {
		anthropic: { models: { 'claude-opus-4-6': ANTHROPIC_MODEL }, name: 'Anthropic' },
		openai: { models: { 'gpt-5': OPENAI_MODEL }, name: 'OpenAI' },
	};
}

describe('fetchModelsDevCatalog', () => {
	it('flattens the nested provider→models map', async () => {
		mockOnce(fixtureCatalog());
		const result = await fetchModelsDevCatalog();
		expect(result).toHaveLength(2);
		const byId = new Map(result.map((e) => [e.modelId, e]));
		expect(byId.get('claude-opus-4-6')?.providerKey).toBe('anthropic');
		expect(byId.get('claude-opus-4-6')?.providerName).toBe('Anthropic');
		expect(byId.get('gpt-5')?.providerKey).toBe('openai');
	});

	it('passes Cloudflare cacheTtl on the fetch call', async () => {
		const spy = mockOnce(fixtureCatalog());
		await fetchModelsDevCatalog();
		const init = spy.mock.calls[0][1] as RequestInit & { cf?: { cacheTtl?: number } };
		expect(init.cf?.cacheTtl).toBe(3600);
	});

	it('throws on a non-2xx response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 500 }));
		await expect(fetchModelsDevCatalog()).rejects.toThrow(/500/);
	});

	it('throws when the schema does not validate', async () => {
		mockOnce({ anthropic: { models: { foo: { name: 123 } } } });
		await expect(fetchModelsDevCatalog()).rejects.toThrow(/models.dev catalog/);
	});

	it('falls back to the map key when the model object has no id', async () => {
		const { id: _omit, ...withoutId } = ANTHROPIC_MODEL;
		mockOnce({ anthropic: { models: { 'claude-opus-4-6': withoutId }, name: 'Anthropic' } });
		const [entry] = await fetchModelsDevCatalog();
		expect(entry.modelId).toBe('claude-opus-4-6');
	});

	it('defaults contextLength to 128_000 when limit is absent', async () => {
		const { limit: _omit, ...withoutLimit } = ANTHROPIC_MODEL;
		mockOnce({ anthropic: { models: { foo: withoutLimit }, name: 'Anthropic' } });
		const [entry] = await fetchModelsDevCatalog();
		expect(entry.contextLength).toBe(128_000);
	});

	it('reports supportsImageInput from modalities.input', async () => {
		mockOnce({
			anthropic: { models: { a: ANTHROPIC_MODEL, b: OPENAI_MODEL }, name: 'Anthropic' },
		});
		const result = await fetchModelsDevCatalog();
		const a = result.find((e) => e.modelId === ANTHROPIC_MODEL.id);
		const b = result.find((e) => e.modelId === OPENAI_MODEL.id);
		expect(a?.supportsImageInput).toBe(true);
		expect(b?.supportsImageInput).toBe(false);
	});
});

function makeEntry(over: Partial<ModelsDevEntry>): ModelsDevEntry {
	return {
		contextLength: 200_000,
		inputCost: 3,
		knowledge: '2025-03-31',
		modelId: 'claude-opus-4-6',
		name: 'Claude Opus 4',
		openWeights: false,
		outputCost: 15,
		providerKey: 'anthropic',
		providerName: 'Anthropic',
		releaseDate: '2025-05-22',
		supportsImageInput: true,
		supportsReasoning: true,
		supportsToolCall: true,
		...over,
	};
}

describe('mapToCreateModelInput', () => {
	it('maps an anthropic claude model with reasoning=max_tokens', () => {
		const input = mapToCreateModelInput(makeEntry({}));
		expect(input).toMatchObject({
			id: 'claude-opus-4-6',
			inputCostPerMillionTokens: 3,
			maxContextLength: 200_000,
			name: 'Claude Opus 4',
			outputCostPerMillionTokens: 15,
			reasoningType: 'max_tokens',
			sortOrder: 0,
			supportsImageInput: true,
		});
	});

	it('maps an openai reasoning model to reasoning=effort', () => {
		const input = mapToCreateModelInput(makeEntry({ modelId: 'gpt-5', name: 'GPT-5', providerKey: 'openai' }));
		expect(input.reasoningType).toBe('effort');
	});

	it('maps gemini-2.5 to max_tokens and gemini-3 to effort', () => {
		const gemini25 = mapToCreateModelInput(makeEntry({ modelId: 'gemini-2.5-pro', providerKey: 'google' }));
		const gemini3 = mapToCreateModelInput(makeEntry({ modelId: 'gemini-3-pro', providerKey: 'google' }));
		expect(gemini25.reasoningType).toBe('max_tokens');
		expect(gemini3.reasoningType).toBe('effort');
	});

	it('forces reasoningType to null when supportsReasoning is false', () => {
		const input = mapToCreateModelInput(makeEntry({ supportsReasoning: false }));
		expect(input.reasoningType).toBe(null);
	});

	it('reflects supportsImageInput', () => {
		const input = mapToCreateModelInput(makeEntry({ supportsImageInput: false }));
		expect(input.supportsImageInput).toBe(false);
	});

	it('prefixes the id when idPrefix is provided', () => {
		const input = mapToCreateModelInput(makeEntry({}), { idPrefix: 'anthropic/' });
		expect(input.id).toBe('anthropic/claude-opus-4-6');
	});

	it('builds a description from release_date + knowledge', () => {
		const input = mapToCreateModelInput(makeEntry({}));
		expect(input.description).toBe('Released 2025-05-22 · Knowledge 2025-03-31');
	});

	it('builds a description from just release_date when knowledge is missing', () => {
		const input = mapToCreateModelInput(makeEntry({ knowledge: null }));
		expect(input.description).toBe('Released 2025-05-22');
	});

	it('returns null description when both release_date and knowledge are missing', () => {
		const input = mapToCreateModelInput(makeEntry({ knowledge: null, releaseDate: null }));
		expect(input.description).toBe(null);
	});

	it('preserves null costs and uses contextLength as-is', () => {
		const input = mapToCreateModelInput(makeEntry({ contextLength: 128_000, inputCost: null, outputCost: null }));
		expect(input.inputCostPerMillionTokens).toBe(null);
		expect(input.outputCostPerMillionTokens).toBe(null);
		expect(input.maxContextLength).toBe(128_000);
	});

	it('threads sortOrder from opts', () => {
		const input = mapToCreateModelInput(makeEntry({}), { sortOrder: 70 });
		expect(input.sortOrder).toBe(70);
	});
});

describe('resolveReasoning', () => {
	it.each([
		['anthropic', 'claude-opus-4-7', 'max_tokens'],
		['openai', 'gpt-5', 'effort'],
		['xai', 'grok-3', 'effort'],
		['google', 'gemini-3-pro', 'effort'],
		['google', 'gemini-2.5-pro', 'max_tokens'],
		['google-ai-studio', 'gemini-3-flash', 'effort'],
	] as const)('maps %s/%s to %s', (key, id, expected) => {
		expect(resolveReasoning(key, id)).toBe(expected);
	});

	it('falls back to inferReasoningType for unknown providers', () => {
		expect(resolveReasoning('openrouter', 'anthropic/claude-sonnet')).toBe('max_tokens');
	});

	it('returns null when no rule matches', () => {
		expect(resolveReasoning('mistralai', 'mistral-small')).toBe(null);
	});
});
