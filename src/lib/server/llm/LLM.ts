// Provider-neutral LLM interface. Adapters (OpenRouter, Anthropic, OpenAI,
// Google, DeepSeek) conform to this; the generation engine in
// ConversationDurableObject consumes only StreamEvents from chat().
//
// The shape mirrors what every modern provider can emit, with
// provider-specific raw payloads carried through the `done` event's `raw` field
// so downstream code (e.g. the meta panel) can keep telemetry without knowing
// which adapter ran.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type TextContent = { type: 'text'; text: string };
export type ImageContent = { type: 'image'; mimeType: string; data: string };
export type FileContent = { type: 'file'; mimeType: string; data: string; name?: string };
export type ToolUseContent = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultContent = {
	type: 'tool_result';
	toolUseId: string;
	content: string;
	isError?: boolean;
};
export type ThinkingContent = { type: 'thinking'; text: string; signature?: string };

export type ContentBlock =
	| TextContent
	| ImageContent
	| FileContent
	| ToolUseContent
	| ToolResultContent
	| ThinkingContent;

export type Message = {
	role: Role;
	content: string | ContentBlock[];
};

export type ToolDefinition = {
	name: string;
	description: string;
	inputSchema: object;
};

export type ThinkingConfig = { type: 'enabled'; budgetTokens: number } | { type: 'disabled' };

export type ReasoningEffort = 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

export type ReasoningConfig =
	| { type: 'max_tokens'; maxTokens: number }
	| { type: 'effort'; effort: ReasoningEffort };

export type CacheControl = { type: 'ephemeral' } | null;

export type Usage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	thinkingTokens?: number;
	totalTokens?: number;
};

export type ChatRequest = {
	messages: Message[];
	systemPrompt?: string;
	tools?: ToolDefinition[];
	thinking?: ThinkingConfig;
	reasoning?: ReasoningConfig;
	cacheControl?: CacheControl;
	temperature?: number;
	maxTokens?: number;
};

export type StreamEvent =
	| { type: 'text_delta'; delta: string }
	| { type: 'thinking_delta'; delta: string }
	| { type: 'tool_call_delta'; id: string; name?: string; argumentsDelta?: string }
	| { type: 'tool_call'; id: string; name: string; input: unknown }
	| { type: 'usage'; usage: Usage }
	| { type: 'done'; finishReason?: string; raw?: unknown }
	| { type: 'error'; message: string };

export default interface LLM {
	get model(): string;
	get providerID(): string;
	chat(request: ChatRequest): AsyncIterable<StreamEvent>;
}
