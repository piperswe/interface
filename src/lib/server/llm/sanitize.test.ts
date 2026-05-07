import { describe, expect, it } from 'vitest';
import { sanitizeHistoryForModel } from './sanitize';
import type { Message } from './LLM';
import type { ResolvedModel } from '../providers/types';

function resolved(opts: {
	providerType?: 'anthropic' | 'openai_compatible';
	supportsImageInput?: boolean;
	reasoningType?: 'effort' | 'max_tokens' | null;
}): ResolvedModel {
	return {
		globalId: 'p/m',
		provider: {
			id: 'p',
			type: opts.providerType ?? 'anthropic',
			apiKey: null,
			endpoint: null,
			gatewayId: null,
			createdAt: 0,
			updatedAt: 0,
		},
		model: {
			id: 'm',
			providerId: 'p',
			name: 'm',
			description: null,
			maxContextLength: 200_000,
			reasoningType: opts.reasoningType ?? null,
			inputCostPerMillionTokens: null,
			outputCostPerMillionTokens: null,
			supportsImageInput: opts.supportsImageInput ?? false,
			sortOrder: 0,
			createdAt: 0,
			updatedAt: 0,
		},
	};
}

describe('sanitizeHistoryForModel', () => {
	it('passes through unchanged when resolved is null', () => {
		const messages: Message[] = [
			{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }] },
		];
		expect(sanitizeHistoryForModel(messages, null)).toEqual(messages);
	});

	it('replaces user image blocks with text placeholder for non-vision models', () => {
		// Regression: switching to a text-only model must not 400 the API on
		// images already in user history.
		const messages: Message[] = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'look at this' },
					{ type: 'image', mimeType: 'image/png', data: 'AAA' },
				],
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: false }));
		expect(out[0].content).toEqual([
			{ type: 'text', text: 'look at this' },
			{ type: 'text', text: '[image redacted: current model does not accept image input]' },
		]);
	});

	it('keeps images intact for vision-capable models', () => {
		const messages: Message[] = [
			{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }] },
		];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: true }));
		expect(out[0].content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'AAA' }]);
	});

	it('redacts image sub-blocks inside multimodal tool_result content for non-vision models', () => {
		// Regression: `sandbox_load_image` returns text + image pairs in tool_result
		// content. A switch to a non-vision model must keep the text and replace
		// the image with a placeholder so the assistant still has the narration.
		const messages: Message[] = [
			{
				role: 'tool',
				content: [
					{
						type: 'tool_result',
						toolUseId: 't1',
						content: [
							{ type: 'text', text: 'Loaded foo.png' },
							{ type: 'image', mimeType: 'image/png', data: 'AAA' },
						],
					},
				],
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: false }));
		const tr = (out[0].content as Array<{ type: string; content: unknown }>)[0];
		expect(tr.content).toEqual([
			{ type: 'text', text: 'Loaded foo.png' },
			{ type: 'text', text: '[image redacted: current model does not accept image input]' },
		]);
	});

	it('collapses image-only tool_result content to a placeholder string', () => {
		const messages: Message[] = [
			{
				role: 'tool',
				content: [
					{
						type: 'tool_result',
						toolUseId: 't1',
						content: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }],
					},
				],
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
				role: 'assistant',
				content: [
					{ type: 'thinking', text: 'planning', signature: 'sig123' },
					{ type: 'text', text: 'hello' },
				],
			},
		];
		const out = sanitizeHistoryForModel(messages, resolved({ reasoningType: null, providerType: 'anthropic' }));
		expect(out[0].content).toEqual([{ type: 'text', text: 'hello' }]);
	});

	it('strips thinking blocks when crossing providers (signatures are anthropic-specific)', () => {
		const messages: Message[] = [
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', text: 'planning', signature: 'anthropic-sig' },
					{ type: 'text', text: 'hello' },
				],
			},
		];
		const out = sanitizeHistoryForModel(
			messages,
			resolved({ providerType: 'openai_compatible', reasoningType: 'effort' }),
		);
		expect(out[0].content).toEqual([{ type: 'text', text: 'hello' }]);
	});

	it('strips signature-less thinking blocks even within Anthropic', () => {
		// Regression: legacy assistant rows may carry thinking parts without
		// signatures (signature capture didn't exist). Sending those to
		// Anthropic with empty signatures triggers a 400.
		const messages: Message[] = [
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', text: 'planning' },
					{ type: 'text', text: 'hello' },
				],
			},
		];
		const out = sanitizeHistoryForModel(
			messages,
			resolved({ providerType: 'anthropic', reasoningType: 'max_tokens' }),
		);
		expect(out[0].content).toEqual([{ type: 'text', text: 'hello' }]);
	});

	it('preserves Anthropic thinking blocks with signatures when staying on Anthropic', () => {
		const messages: Message[] = [
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', text: 'planning', signature: 'sig123' },
					{ type: 'text', text: 'hello' },
				],
			},
		];
		const out = sanitizeHistoryForModel(
			messages,
			resolved({ providerType: 'anthropic', reasoningType: 'max_tokens' }),
		);
		expect(out[0].content).toEqual([
			{ type: 'thinking', text: 'planning', signature: 'sig123' },
			{ type: 'text', text: 'hello' },
		]);
	});

	it('strips tool_use thoughtSignature when destination is not openai_compatible', () => {
		// Regression: thoughtSignature is the Gemini-via-OpenAI-compat shape;
		// other providers should never see it.
		const messages: Message[] = [
			{
				role: 'assistant',
				content: [{ type: 'tool_use', id: 't1', name: 'x', input: {}, thoughtSignature: 'gem-sig' }],
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
				role: 'assistant',
				content: [{ type: 'tool_use', id: 't1', name: 'x', input: {}, thoughtSignature: 'gem-sig' }],
			},
		];
		const out = sanitizeHistoryForModel(
			messages,
			resolved({ providerType: 'openai_compatible' }),
		);
		const tu = (out[0].content as Array<Record<string, unknown>>)[0];
		expect(tu.thoughtSignature).toBe('gem-sig');
	});

	it('leaves string-content messages alone', () => {
		const messages: Message[] = [{ role: 'user', content: 'hello' }];
		const out = sanitizeHistoryForModel(messages, resolved({ supportsImageInput: false }));
		expect(out).toEqual(messages);
	});
});
