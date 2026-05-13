import { describe, expect, it } from 'vitest';
import type { ResolvedModel } from '../providers/types';
import type { Message } from './LLM';
import { sanitizeHistoryForModel } from './sanitize';

function resolved(opts: {
	providerType?: 'anthropic' | 'openai_compatible';
	supportsImageInput?: boolean;
	reasoningType?: 'effort' | 'max_tokens' | null;
}): ResolvedModel {
	return {
		globalId: 'p/m',
		model: {
			createdAt: 0,
			description: null,
			id: 'm',
			inputCostPerMillionTokens: null,
			maxContextLength: 200_000,
			name: 'm',
			outputCostPerMillionTokens: null,
			providerId: 'p',
			reasoningType: opts.reasoningType ?? null,
			sortOrder: 0,
			supportsImageInput: opts.supportsImageInput ?? false,
			updatedAt: 0,
		},
		provider: {
			apiKey: null,
			createdAt: 0,
			endpoint: null,
			gatewayId: null,
			id: 'p',
			type: opts.providerType ?? 'anthropic',
			updatedAt: 0,
		},
	};
}

describe('sanitizeHistoryForModel', () => {
	it('passes through unchanged when resolved is null', () => {
		const messages: Message[] = [{ content: [{ data: 'AAA', mimeType: 'image/png', type: 'image' }], role: 'user' }];
		expect(sanitizeHistoryForModel(messages, null)).toEqual(messages);
	});

	it('replaces user image blocks with text placeholder for non-vision models', () => {
		// Regression: switching to a text-only model must not 400 the API on
		// images already in user history.
		const messages: Message[] = [
			{
				content: [
					{ text: 'look at this', type: 'text' },
					{ data: 'AAA', mimeType: 'image/png', type: 'image' },
				],
				role: 'user',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: false }));
		expect(out[0].content).toEqual([
			{ text: 'look at this', type: 'text' },
			{ text: '[image redacted: current model does not accept image input]', type: 'text' },
		]);
	});

	it('keeps images intact for vision-capable models', () => {
		const messages: Message[] = [{ content: [{ data: 'AAA', mimeType: 'image/png', type: 'image' }], role: 'user' }];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: true }));
		expect(out[0].content).toEqual([{ data: 'AAA', mimeType: 'image/png', type: 'image' }]);
	});

	it('redacts image sub-blocks inside multimodal tool_result content for non-vision models', () => {
		// Regression: `sandbox_load_image` returns text + image pairs in tool_result
		// content. A switch to a non-vision model must keep the text and replace
		// the image with a placeholder so the assistant still has the narration.
		const messages: Message[] = [
			{
				content: [
					{
						content: [
							{ text: 'Loaded foo.png', type: 'text' },
							{ data: 'AAA', mimeType: 'image/png', type: 'image' },
						],
						toolUseId: 't1',
						type: 'tool_result',
					},
				],
				role: 'tool',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: false }));
		const tr = (out[0].content as Array<{ type: string; content: unknown }>)[0];
		expect(tr.content).toEqual([
			{ text: 'Loaded foo.png', type: 'text' },
			{ text: '[image redacted: current model does not accept image input]', type: 'text' },
		]);
	});

	it('collapses image-only tool_result content to a placeholder string', () => {
		const messages: Message[] = [
			{
				content: [
					{
						content: [{ data: 'AAA', mimeType: 'image/png', type: 'image' }],
						toolUseId: 't1',
						type: 'tool_result',
					},
				],
				role: 'tool',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: false }));
		const tr = (out[0].content as Array<{ type: string; content: unknown }>)[0];
		expect(tr.content).toBe('[image redacted: current model does not accept image input]');
	});

	it('strips thinking blocks when the destination model has no reasoningType', () => {
		// Regression: thinking blocks in history would otherwise be sent to a
		// non-thinking model, which either drops them silently (OpenAI) or
		// rejects with a 400 (Anthropic).
		const messages: Message[] = [
			{
				content: [
					{ signature: 'sig123', text: 'planning', type: 'thinking' },
					{ text: 'hello', type: 'text' },
				],
				role: 'assistant',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ providerType: 'anthropic', reasoningType: null }));
		expect(out[0].content).toEqual([{ text: 'hello', type: 'text' }]);
	});

	it('strips thinking blocks when crossing providers (signatures are anthropic-specific)', () => {
		const messages: Message[] = [
			{
				content: [
					{ signature: 'anthropic-sig', text: 'planning', type: 'thinking' },
					{ text: 'hello', type: 'text' },
				],
				role: 'assistant',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ providerType: 'openai_compatible', reasoningType: 'effort' }));
		expect(out[0].content).toEqual([{ text: 'hello', type: 'text' }]);
	});

	it('strips signature-less thinking blocks even within Anthropic', () => {
		// Regression: legacy assistant rows may carry thinking parts without
		// signatures (signature capture didn't exist). Sending those to
		// Anthropic with empty signatures triggers a 400.
		const messages: Message[] = [
			{
				content: [
					{ text: 'planning', type: 'thinking' },
					{ text: 'hello', type: 'text' },
				],
				role: 'assistant',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ providerType: 'anthropic', reasoningType: 'max_tokens' }));
		expect(out[0].content).toEqual([{ text: 'hello', type: 'text' }]);
	});

	it('preserves Anthropic thinking blocks with signatures when staying on Anthropic', () => {
		const messages: Message[] = [
			{
				content: [
					{ signature: 'sig123', text: 'planning', type: 'thinking' },
					{ text: 'hello', type: 'text' },
				],
				role: 'assistant',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ providerType: 'anthropic', reasoningType: 'max_tokens' }));
		expect(out[0].content).toEqual([
			{ signature: 'sig123', text: 'planning', type: 'thinking' },
			{ text: 'hello', type: 'text' },
		]);
	});

	it('strips tool_use thoughtSignature when destination is not openai_compatible', () => {
		// Regression: thoughtSignature is the Gemini-via-OpenAI-compat shape;
		// other providers should never see it.
		const messages: Message[] = [
			{
				content: [{ id: 't1', input: {}, name: 'x', thoughtSignature: 'gem-sig', type: 'tool_use' }],
				role: 'assistant',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ providerType: 'anthropic' }));
		const tu = (out[0].content as Array<Record<string, unknown>>)[0];
		expect(tu.thoughtSignature).toBeUndefined();
		expect(tu.id).toBe('t1');
	});

	it('keeps tool_use thoughtSignature when destination is openai_compatible', () => {
		const messages: Message[] = [
			{
				content: [{ id: 't1', input: {}, name: 'x', thoughtSignature: 'gem-sig', type: 'tool_use' }],
				role: 'assistant',
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ providerType: 'openai_compatible' }));
		const tu = (out[0].content as Array<Record<string, unknown>>)[0];
		expect(tu.thoughtSignature).toBe('gem-sig');
	});

	it('leaves string-content messages alone', () => {
		const messages: Message[] = [{ content: 'hello', role: 'user' }];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: false }));
		expect(out).toEqual(messages);
	});
});
