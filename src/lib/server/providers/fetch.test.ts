import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenRouterModels } from './fetch';

afterEach(() => {
	vi.restoreAllMocks();
});

function mockOnce(body: unknown, init?: ResponseInit) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(typeof body === 'string' ? body : JSON.stringify(body), init));
}

describe('fetchOpenRouterModels', () => {
	it('maps a normal response payload', async () => {
		mockOnce({
			data: [
				{
					context_length: 200_000,
					description: 'long context',
					id: 'anthropic/claude-sonnet-4-6',
					name: 'Claude Sonnet 4.6',
				},
			],
		});
		const result = await fetchOpenRouterModels();
		expect(result).toEqual([
			{
				description: 'long context',
				id: 'anthropic/claude-sonnet-4-6',
				maxContextLength: 200_000,
				name: 'Claude Sonnet 4.6',
				reasoningType: 'max_tokens',
			},
		]);
	});

	it('falls back to top_provider.context_length when context_length is missing', async () => {
		mockOnce({
			data: [
				{
					id: 'openai/o3',
					name: 'O3',
					top_provider: { context_length: 256_000 },
				},
			],
		});
		const [model] = await fetchOpenRouterModels();
		expect(model.maxContextLength).toBe(256_000);
	});

	it('defaults context length to 128_000 when both fields are missing', async () => {
		mockOnce({ data: [{ id: 'foo/bar', name: 'Bar' }] });
		const [model] = await fetchOpenRouterModels();
		expect(model.maxContextLength).toBe(128_000);
	});

	it('uses the model id as a fallback name when name is missing', async () => {
		mockOnce({ data: [{ id: 'foo/bar' }] });
		const [model] = await fetchOpenRouterModels();
		expect(model.name).toBe('foo/bar');
	});

	it.each([
		['openai/o3-mini', 'effort'],
		['openai/gpt-5.5', 'effort'],
		['x-ai/grok-3', 'effort'],
		['google/gemini-3-pro', 'effort'],
		['anthropic/claude-sonnet-4-6', 'max_tokens'],
		['claude-haiku-4-5', 'max_tokens'],
		['moonshotai/kimi-k2.6', 'max_tokens'],
		['google/gemini-2.5-pro', 'max_tokens'],
		['alibaba/qwen3-coder', 'max_tokens'],
		['mistralai/mistral-small', undefined],
	] as const)('infers reasoningType for %s', async (id, expected) => {
		mockOnce({ data: [{ id, name: id }] });
		const [model] = await fetchOpenRouterModels();
		expect(model.reasoningType).toBe(expected);
	});

	it('forwards Authorization: Bearer <key> when an apiKey is supplied', async () => {
		const spy = mockOnce({ data: [] });
		await fetchOpenRouterModels('sk-or-test');
		const init = spy.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
	});

	it('omits Authorization when no apiKey is supplied', async () => {
		const spy = mockOnce({ data: [] });
		await fetchOpenRouterModels();
		const init = spy.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
		expect((init.headers as Record<string, string>).Accept).toBe('application/json');
	});

	it('throws on a non-2xx response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 500 }));
		await expect(fetchOpenRouterModels()).rejects.toThrow(/500/);
	});

	it('handles an empty data array', async () => {
		mockOnce({});
		const result = await fetchOpenRouterModels();
		expect(result).toEqual([]);
	});
});
