import { OpenRouter } from '@openrouter/sdk';
import { getModelContextWindow } from '../openrouter/models';
import { getContextCompactionThreshold, getContextCompactionSummaryTokens } from '../settings';
import { routeLLM } from './route';
import type { Message } from './LLM';

// Tokens ≈ characters / 4, with ~10% safety margin.
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4 * 1.1);
}

function estimateMessagesTokens(messages: Message[]): number {
	let sum = 0;
	for (const m of messages) {
		if (typeof m.content === 'string') {
			sum += estimateTokens(m.content);
		} else {
			for (const block of m.content) {
				if (block.type === 'text') sum += estimateTokens(block.text);
				else sum += estimateTokens(JSON.stringify(block));
			}
		}
	}
	return sum;
}

function messagesToText(messages: Message[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		const role = m.role === 'assistant' ? 'Assistant' : 'User';
		const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
		parts.push(`${role}: ${text}`);
	}
	return parts.join('\n\n');
}

export type CompactionResult = {
	messages: Message[];
	wasCompacted: boolean;
	summary: string | null;
	droppedCount: number;
};

export async function compactHistory(
	messages: Message[],
	model: string,
	env: Env,
	lastUsage: { inputTokens: number } | null,
): Promise<CompactionResult> {
	const threshold = await getContextCompactionThreshold(env);
	if (threshold === 0) {
		return { messages, wasCompacted: false, summary: null, droppedCount: 0 };
	}

	const contextWindow = await getModelContextWindow(env, model);
	const summaryTokens = await getContextCompactionSummaryTokens(env);
	const maxAllowed = Math.floor(contextWindow * (threshold / 100));

	// Estimate current token count.
	let estimated = lastUsage?.inputTokens ?? estimateMessagesTokens(messages);
	// Add safety margin for the new assistant response.
	estimated += 1024;

	if (estimated <= maxAllowed) {
		return { messages, wasCompacted: false, summary: null, droppedCount: 0 };
	}

	// We need to drop some of the oldest messages to make room while keeping
	// recent context intact. Preserve at least the most recent 2 exchanges
	// (4 messages) and never compact a conversation with 2 or fewer turns.
	const minKeep = Math.min(4, messages.length);
	if (messages.length <= minKeep) {
		return { messages, wasCompacted: false, summary: null, droppedCount: 0 };
	}

	// Walk from the oldest message forward, adding to the drop pile until
	// the remaining messages (plus a system summary) fall under the threshold.
	let dropIndex = 0;
	for (let i = 0; i <= messages.length - minKeep; i++) {
		const remaining = messages.slice(i);
		const remainingEstimate = estimateMessagesTokens(remaining) + estimateTokens('[summary]');
		if (remainingEstimate <= maxAllowed) {
			dropIndex = i;
			break;
		}
		// If we've exhausted options, drop half the oldest messages.
		if (i === messages.length - minKeep) {
			dropIndex = Math.floor(i / 2);
		}
	}

	const dropped = messages.slice(0, dropIndex);
	const remaining = messages.slice(dropIndex);
	const droppedText = messagesToText(dropped);

	let summary: string;
	try {
		const llm = routeLLM(env, model);
		let buf = '';
		for await (const ev of llm.chat({
			messages: [
				{
					role: 'system',
					content:
						'Summarize the key points from this conversation transcript concisely but comprehensively. ' +
						'Preserve all important facts, decisions, user instructions, and context that may be needed later. ' +
						'Reply with the summary only — no meta commentary.',
				},
				{ role: 'user', content: droppedText },
			],
			maxTokens: summaryTokens,
			temperature: 0.3,
		})) {
			if (ev.type === 'text_delta') buf += ev.delta;
			if (ev.type === 'error') throw new Error(ev.message);
		}
		summary = buf.trim();
	} catch {
		// If summarization fails, fall back to the raw text so we don't lose context.
		summary = droppedText.slice(0, 4000);
	}

	const summaryMessage: Message = {
		role: 'system',
		content: `Previous conversation summary: ${summary}`,
	};

	return {
		messages: [summaryMessage, ...remaining],
		wasCompacted: true,
		summary,
		droppedCount: dropped.length,
	};
}
