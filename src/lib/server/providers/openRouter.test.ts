import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenRouterCatalog, mapOpenRouterToCreateModelInput, type OpenRouterEntry } from './openRouter';

afterEach(() => {
	vi.restoreAllMocks();
});

function mockOnce(body: unknown, init?: ResponseInit) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(typeof body === 'string' ? body : JSON.stringify(body), init));
}

const CLAUDE_MODEL = {
	architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
	context_length: 200_000,
	description: 'Most capable Claude model.',
	id: 'anthropic/claude-opus-4-6',
	knowledge_cutoff: '2025-03-31',
	name: 'Anthropic: Claude Opus 4',
	pricing: { completion: '0.000075', prompt: '0.000015' },
	supported_parameters: ['reasoning', 'max_tokens'],
	top_provider: { context_length: 200_000 },
};

const GPT5_MODEL = {
	architecture: { input_modalities: ['text'], output_modalities: ['text'] },
	context_length: 400_000,
	description: 'Frontier reasoning model.',
	id: 'openai/gpt-5',
	knowledge_cutoff: null,
	name: 'OpenAI: GPT-5',
	pricing: { completion: '0.00001', prompt: '0.00000125' },
	supported_parameters: ['reasoning_effort', 'max_completion_tokens'],
	top_provider: { context_length: 400_000 },
};

function fixtureResponse() {
	return { data: [CLAUDE_MODEL, GPT5_MODEL] };
}

describe('fetchOpenRouterCatalog', () => {
	it('flattens the data array and extracts vendor from the first path segment', async () => {
		mockOnce(fixtureResponse());
		const result = await fetchOpenRouterCatalog();
		expect(result).toHaveLength(2);
		const byId = new Map(result.map((e) => [e.fullId, e]));
		expect(byId.get('anthropic/claude-opus-4-6')).toMatchObject({ vendor: 'anthropic' });
		expect(byId.get('openai/gpt-5')).toMatchObject({ vendor: 'openai' });
	});

	it('uses the full id as vendor when no slash is present', async () => {
		mockOnce({ data: [{ ...CLAUDE_MODEL, id: 'standalone-model' }] });
		const [entry] = await fetchOpenRouterCatalog();
		expect(entry.vendor).toBe('standalone-model');
		expect(entry.fullId).toBe('standalone-model');
	});

	it('extracts only the first segment as vendor for multi-slash ids', async () => {
		mockOnce({ data: [{ ...CLAUDE_MODEL, id: 'meta-llama/llama-3.1/405b' }] });
		const [entry] = await fetchOpenRouterCatalog();
		expect(entry.vendor).toBe('meta-llama');
		expect(entry.fullId).toBe('meta-llama/llama-3.1/405b');
	});

	it('passes Cloudflare cacheTtl on the fetch call', async () => {
		const spy = mockOnce(fixtureResponse());
		await fetchOpenRouterCatalog();
		const init = spy.mock.calls[0][1] as RequestInit & { cf?: { cacheTtl?: number } };
		expect(init.cf?.cacheTtl).toBe(3600);
	});

	it('throws on a non-2xx response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 500 }));
		await expect(fetchOpenRouterCatalog()).rejects.toThrow(/500/);
	});

	it('throws when the schema does not validate', async () => {
		mockOnce({ data: [{ name: 'missing id' }] });
		await expect(fetchOpenRouterCatalog()).rejects.toThrow(/OpenRouter models catalog/);
	});

	it('converts per-token prices to per-million tokens', async () => {
		mockOnce(fixtureResponse());
		const [claude, gpt5] = await fetchOpenRouterCatalog();
		// "0.000015" * 1e6 = 15.0
		expect(claude.inputCostPerMillionTokens).toBe(15);
		expect(claude.outputCostPerMillionTokens).toBe(75);
		// "0.00000125" * 1e6 = 1.25; rounding clamps floating-point noise
		expect(gpt5.inputCostPerMillionTokens).toBe(1.25);
		expect(gpt5.outputCostPerMillionTokens).toBe(10);
	});

	it('treats empty / "0" / unparsable prices as null', async () => {
		mockOnce({
			data: [
				{ ...CLAUDE_MODEL, pricing: { completion: '0', prompt: '' } },
				{ ...GPT5_MODEL, pricing: { completion: '0.000001', prompt: 'free' } },
			],
		});
		const [a, b] = await fetchOpenRouterCatalog();
		expect(a.inputCostPerMillionTokens).toBe(null);
		expect(a.outputCostPerMillionTokens).toBe(null);
		expect(b.inputCostPerMillionTokens).toBe(null);
		expect(b.outputCostPerMillionTokens).toBe(1);
	});

	it('reports supportsImageInput from architecture.input_modalities', async () => {
		mockOnce(fixtureResponse());
		const [claude, gpt5] = await fetchOpenRouterCatalog();
		expect(claude.supportsImageInput).toBe(true);
		expect(gpt5.supportsImageInput).toBe(false);
	});

	it('resolves reasoningType from supported_parameters before falling back to id inference', async () => {
		mockOnce(fixtureResponse());
		const [claude, gpt5] = await fetchOpenRouterCatalog();
		expect(claude.reasoningType).toBe('max_tokens');
		expect(claude.supportsReasoning).toBe(true);
		expect(gpt5.reasoningType).toBe('effort');
		expect(gpt5.supportsReasoning).toBe(true);
	});

	it('reasoning_effort in supported_parameters beats name-based max_tokens inference', async () => {
		// An anthropic-prefixed id would normally infer max_tokens; explicit
		// reasoning_effort support should win.
		mockOnce({
			data: [{ ...CLAUDE_MODEL, supported_parameters: ['reasoning_effort'] }],
		});
		const [entry] = await fetchOpenRouterCatalog();
		expect(entry.reasoningType).toBe('effort');
	});

	it('falls back to inferReasoningType when supported_parameters omits reasoning hints', async () => {
		mockOnce({ data: [{ ...CLAUDE_MODEL, supported_parameters: ['max_tokens'] }] });
		const [entry] = await fetchOpenRouterCatalog();
		// anthropic/* → max_tokens via inferReasoningType
		expect(entry.reasoningType).toBe('max_tokens');
	});

	it('returns null reasoningType for non-reasoning models with no hints', async () => {
		mockOnce({
			data: [{ ...CLAUDE_MODEL, id: 'mistralai/mistral-small', supported_parameters: ['max_tokens'] }],
		});
		const [entry] = await fetchOpenRouterCatalog();
		expect(entry.reasoningType).toBe(null);
		expect(entry.supportsReasoning).toBe(false);
	});

	it('defaults contextLength to 128_000 when both fields are absent', async () => {
		mockOnce({
			data: [{ ...CLAUDE_MODEL, context_length: null, top_provider: { context_length: null } }],
		});
		const [entry] = await fetchOpenRouterCatalog();
		expect(entry.contextLength).toBe(128_000);
	});

	it('builds a description from description + knowledge_cutoff', async () => {
		mockOnce(fixtureResponse());
		const [claude] = await fetchOpenRouterCatalog();
		expect(claude.description).toBe('Most capable Claude model. · Knowledge 2025-03-31');
	});

	it('returns null description when both description and knowledge_cutoff are missing', async () => {
		mockOnce({
			data: [{ ...CLAUDE_MODEL, description: undefined, knowledge_cutoff: null }],
		});
		const [entry] = await fetchOpenRouterCatalog();
		expect(entry.description).toBe(null);
	});

	it('truncates long descriptions with an ellipsis', async () => {
		const longDesc = 'x'.repeat(500);
		mockOnce({
			data: [{ ...CLAUDE_MODEL, description: longDesc, knowledge_cutoff: null }],
		});
		const [entry] = await fetchOpenRouterCatalog();
		expect(entry.description?.endsWith('…')).toBe(true);
		expect(entry.description?.length).toBeLessThanOrEqual(280);
	});
});

function makeEntry(over: Partial<OpenRouterEntry> = {}): OpenRouterEntry {
	return {
		contextLength: 200_000,
		description: 'Most capable Claude model.',
		fullId: 'anthropic/claude-opus-4-6',
		inputCostPerMillionTokens: 15,
		knowledgeCutoff: '2025-03-31',
		name: 'Anthropic: Claude Opus 4',
		outputCostPerMillionTokens: 75,
		reasoningType: 'max_tokens',
		supportsImageInput: true,
		supportsReasoning: true,
		vendor: 'anthropic',
		...over,
	};
}

describe('mapOpenRouterToCreateModelInput', () => {
	it('uses the OpenRouter fullId as the model id', () => {
		const input = mapOpenRouterToCreateModelInput(makeEntry());
		expect(input.id).toBe('anthropic/claude-opus-4-6');
	});

	it('passes through all the prefilled metadata', () => {
		const input = mapOpenRouterToCreateModelInput(makeEntry());
		expect(input).toMatchObject({
			description: 'Most capable Claude model.',
			inputCostPerMillionTokens: 15,
			maxContextLength: 200_000,
			name: 'Anthropic: Claude Opus 4',
			outputCostPerMillionTokens: 75,
			reasoningType: 'max_tokens',
			sortOrder: 0,
			supportsImageInput: true,
		});
	});

	it('threads sortOrder from opts', () => {
		const input = mapOpenRouterToCreateModelInput(makeEntry(), { sortOrder: 70 });
		expect(input.sortOrder).toBe(70);
	});

	it('preserves null costs', () => {
		const input = mapOpenRouterToCreateModelInput(makeEntry({ inputCostPerMillionTokens: null, outputCostPerMillionTokens: null }));
		expect(input.inputCostPerMillionTokens).toBe(null);
		expect(input.outputCostPerMillionTokens).toBe(null);
	});

	it('preserves null reasoningType', () => {
		const input = mapOpenRouterToCreateModelInput(makeEntry({ reasoningType: null, supportsReasoning: false }));
		expect(input.reasoningType).toBe(null);
	});
});
