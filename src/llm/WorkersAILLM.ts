import LLM from './LLM';

export default class WorkersAILLM implements LLM {
	#ai: Ai;
	id: string;
	providerID: string;
	gatewayID?: string;

	constructor(ai: Ai, id: string, providerID: string, gatewayID?: string) {
		this.#ai = ai;
		this.id = id;
		this.providerID = providerID;
		this.gatewayID = gatewayID;
	}

	async chatCompletions(request: ChatCompletionsMessagesInput): Promise<ChatCompletionsOutput> {
		return (await this.#ai.run(this.id, request, {
			gateway: this.gatewayID ? { id: this.gatewayID } : undefined,
		})) as ChatCompletionsOutput;
	}
}
