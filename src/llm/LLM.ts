export default interface LLM {
	get id(): string;
	get providerID(): string;
	chatCompletions(request: ChatCompletionsMessagesInput): Promise<ChatCompletionsOutput>;
}
