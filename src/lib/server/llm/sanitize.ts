import type { ResolvedModel } from '../providers/types';
import type { ContentBlock, Message, ToolResultBlock } from './LLM';

// Per-turn message sanitizer applied just before `llm.chat({ messages })`.
// The persisted timeline keeps full fidelity (images, thinking, signatures);
// we only filter the bytes shipped to the active provider so a switch to a
// less-capable model doesn't break the request and a later switch back to a
// capable model restores the full view.
//
// Rules:
//   - Images: dropped from user/tool messages, and replaced inside multimodal
//     `tool_result` blocks, when the model's `supportsImageInput` is false.
//   - Thinking: stripped from assistant messages unless the model is native
//     Anthropic AND has a `reasoningType` AND the block carries a non-empty
//     signature. Cross-provider thinking is meaningless (signatures are
//     Anthropic-specific) and Anthropic itself rejects empty-signature thinking
//     in tool-interleaved turns.
//   - tool_use `thoughtSignature`: kept only when the destination is an
//     `openai_compatible` provider (where Gemini's signature actually rides
//     in `extra_content`); other providers ignore the field but we strip it
//     anyway to keep the wire shape clean.

const REDACTED_IMAGE_TEXT = '[image redacted: current model does not accept image input]';

export function sanitizeHistoryForModel(messages: Message[], resolved: ResolvedModel | null): Message[] {
	// Without a resolved model we can't make any capability-aware decisions;
	// pass through unchanged so the API call surfaces the underlying error
	// instead of this layer silently mangling history.
	if (!resolved) return messages;
	const supportsImages = resolved.model.supportsImageInput;
	const isAnthropic = resolved.provider.type === 'anthropic';
	const supportsThinking = isAnthropic && resolved.model.reasoningType != null;
	const keepThoughtSignature = resolved.provider.type === 'openai_compatible';

	return messages.map((m) => {
		if (typeof m.content === 'string') return m;
		const filtered: ContentBlock[] = [];
		for (const b of m.content) {
			if (b.type === 'image') {
				if (supportsImages) {
					filtered.push(b);
				} else {
					filtered.push({ text: REDACTED_IMAGE_TEXT, type: 'text' });
				}
				continue;
			}
			if (b.type === 'thinking') {
				if (supportsThinking && b.signature) {
					filtered.push(b);
				}
				continue;
			}
			if (b.type === 'tool_use') {
				if (keepThoughtSignature || !b.thoughtSignature) {
					filtered.push(b);
				} else {
					const { thoughtSignature: _drop, ...rest } = b;
					void _drop;
					filtered.push(rest);
				}
				continue;
			}
			if (b.type === 'tool_result') {
				filtered.push(sanitizeToolResultBlock(b, supportsImages));
				continue;
			}
			filtered.push(b);
		}
		return { ...m, content: filtered };
	});
}

function sanitizeToolResultBlock(b: ContentBlock & { type: 'tool_result' }, supportsImages: boolean): ContentBlock {
	if (typeof b.content === 'string') return b;
	if (supportsImages) return b;
	const subBlocks: ToolResultBlock[] = b.content.map((sub) =>
		sub.type === 'image' ? { text: REDACTED_IMAGE_TEXT, type: 'text' as const } : sub,
	);
	// If the only thing left is one or more redacted-image placeholders with no
	// genuine narration, collapse the array to a single string so the block
	// isn't structurally noisy.
	const onlyPlaceholders = subBlocks.every((sub) => sub.type === 'text' && sub.text === REDACTED_IMAGE_TEXT);
	if (onlyPlaceholders) {
		return { ...b, content: REDACTED_IMAGE_TEXT };
	}
	return { ...b, content: subBlocks };
}
