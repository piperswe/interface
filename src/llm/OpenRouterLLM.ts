import { OpenRouter } from '@openrouter/sdk';
import LLM from './LLM';
import { ChatRequest, ChatResult, ChatStreamChunk } from '@openrouter/sdk/esm/models';

export class OpenRouterLLM implements LLM {
	#client: OpenRouter;
	model: string;
	providerID: string;

	constructor(client: OpenRouter, model: string, providerID: string) {
		this.#client = client;
		this.model = model;
		this.providerID = providerID;
	}

	async chatCompletions(request: ChatRequest): Promise<ChatResult> {
		return await this.#client.chat.send({
			chatRequest: {
				...request,
				model: this.model,
				stream: false,
			},
		});
	}

	async *chatCompletionsStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
		const stream = await this.#client.chat.send({
			chatRequest: {
				...request,
				model: this.model,
				stream: true,
			},
		});
		for await (const chunk of stream) {
			yield chunk;
		}
	}
}
