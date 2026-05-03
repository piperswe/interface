import { ChatRequest, ChatResult, ChatStreamChunk } from '@openrouter/sdk/esm/models';

export default interface LLM {
	get model(): string;
	get providerID(): string;
	chatCompletions(request: ChatRequest): Promise<ChatResult>;
	chatCompletionsStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
}
