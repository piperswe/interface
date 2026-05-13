import { env, runInDurableObject } from 'cloudflare:test';
import type { ConversationState } from '$lib/types/conversation';
import type { ChatRequest } from '../../llm/LLM';
import { type ConversationStub, getConversationStub } from '../index';

type WithLLMOverride = {
	__setLLMOverride(script: unknown[] | null): Promise<void>;
};

// Read whatever requests the DO's override LLM has captured so far. Lets
// resume tests assert that the recovered tool history was replayed into
// the LLM's `messages` array.
export async function readLLMCalls(stub: ConversationStub): Promise<ChatRequest[]> {
	return runInDurableObject(stub, async (instance) => {
		const inst = instance as unknown as { __llmOverrideCalls?: ChatRequest[] };
		return (inst.__llmOverrideCalls ?? []).map((c) => ({ ...c, messages: c.messages.slice() }));
	});
}

// Subscribe-and-immediately-cancel: triggers the DO's resume detection on
// `subscribe` without leaving an open SSE stream behind. Works whether or
// not a constructor-scheduled alarm fired (it sometimes hasn't, in tests).
export async function pokeSubscribe(stub: ConversationStub): Promise<void> {
	const stream = await stub.subscribe();
	const reader = stream.getReader();
	await reader.read();
	await reader.cancel();
}

export async function setOverride(stub: ConversationStub, script: unknown[][]): Promise<void> {
	await (stub as unknown as WithLLMOverride).__setLLMOverride(script);
}

export async function waitForState(
	stub: ConversationStub,
	predicate: (s: ConversationState) => boolean,
	{ timeoutMs = 5000, pollMs = 25 } = {},
): Promise<ConversationState> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = await readState(stub);
		if (predicate(state)) return state;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	throw new Error('waitForState: timeout');
}

export function stubFor(conversationId: string): ConversationStub {
	return getConversationStub(env, conversationId);
}

// `DurableObjectStub<>` walks every field of the RPC return type through
// Cloudflare's Serializable<> constraint. ConversationState's nested
// MessageRow + Artifact + ToolCall structure exceeds TS's recursion budget.
// Reading getState through this typed view keeps tests readable without
// triggering the depth limit.
export async function readState(stub: ConversationStub): Promise<ConversationState> {
	return await (stub as unknown as { getState(): Promise<ConversationState> }).getState();
}
