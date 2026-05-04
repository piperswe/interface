// Test double for the provider-neutral LLM interface. Each `chat()` call
// shifts the next scripted event sequence off the queue and yields it. Used
// by `#generate` and sub-agent tests that need deterministic streams without
// hitting a real provider.

import type LLM from '../../src/lib/server/llm/LLM';
import type { ChatRequest, StreamEvent } from '../../src/lib/server/llm/LLM';

export type ScriptedTurn = {
	events: StreamEvent[];
};

export class FakeLLM implements LLM {
	model = 'fake/model';
	providerID = 'fake';
	#turns: ScriptedTurn[];
	calls: ChatRequest[] = [];

	constructor(turns: ScriptedTurn[]) {
		this.#turns = [...turns];
	}

	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		this.calls.push(request);
		const turn = this.#turns.shift();
		if (!turn) {
			yield { type: 'error', message: 'FakeLLM: ran out of scripted turns' };
			return;
		}
		for (const ev of turn.events) {
			yield ev;
		}
	}

	get remaining(): number {
		return this.#turns.length;
	}
}

// Convenience builder for a single text-only assistant turn.
export function textTurn(text: string): ScriptedTurn {
	return {
		events: [
			{ type: 'text_delta', delta: text },
			{ type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
			{ type: 'done', finishReason: 'stop' },
		],
	};
}

// Convenience builder for a turn that emits a single tool_use, no text.
export function toolUseTurn(id: string, name: string, input: unknown): ScriptedTurn {
	return {
		events: [
			{ type: 'tool_call', id, name, input },
			{ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
			{ type: 'done', finishReason: 'tool_use' },
		],
	};
}
