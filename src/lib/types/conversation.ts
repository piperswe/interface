export type Conversation = {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
	thinking_budget?: number | null;
	archived_at?: number | null;
	style_id?: number | null;
	system_prompt?: string | null;
};

// Token-usage shape persisted in `messages.usage_json`. Mirrors `Usage` in
// `$lib/server/llm/LLM` — declared here too so frontend code can import it
// without crossing the server-only boundary.
export type ConversationUsage = {
	inputTokens: number;
	outputTokens: number;
	totalTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	thinkingTokens?: number;
	// USD cost reported by the provider, when available. Falls back to a
	// per-model price computation at display time.
	cost?: number;
};

export interface MetaSnapshot {
	startedAt: number;
	firstTokenAt: number;
	// Raw provider response chunk (OpenAI-compat shape or provider-specific)
	lastChunk: unknown | null;
	usage: ConversationUsage | null;
}

// Artifact types: code (syntax-highlighted), markdown (rendered), and rich
// media previews (html iframe, svg inline, mermaid client-side).
export type ArtifactType = 'code' | 'markdown' | 'html' | 'svg' | 'mermaid';

export type Artifact = {
	id: string;
	messageId: string;
	type: ArtifactType;
	name: string | null;
	version: number;
	content: string;
	createdAt: number;
	// Server-rendered HTML (for code: shiki-highlighted; for markdown: marked + KaTeX).
	contentHtml?: string | null;
	// Code artifacts may carry a language hint; ignored for markdown.
	language?: string | null;
};

// Tool inputs are JSON values from the model. Typed permissively (`any`) so
// the DurableObjectStub<> RPC type checks resolve — Cloudflare's Serializable<>
// rejects `unknown` field types. `JsonRecord` narrows to a recursive shape
// for code that constructs values; the wire type stays `any` so RPC works.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonValue = any;
export type JsonRecord = string | number | boolean | null | JsonRecord[] | { [k: string]: JsonRecord };

export type ToolCallRecord = {
	id: string;
	name: string;
	input: JsonValue;
	inputHtml?: string;
	thoughtSignature?: string;
	startedAt?: number;
};
// One block of a tool result; mirrors `ToolResultBlock` in
// `src/lib/server/llm/LLM.ts` so client code can import it without crossing
// the server-only boundary.
export type ToolResultBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };
export type ToolResultRecord = {
	toolUseId: string;
	content: string | ToolResultBlock[];
	isError: boolean;
	streaming?: boolean;
	startedAt?: number;
	endedAt?: number;
};

// Ordered timeline of an assistant turn: thinking, text segments, tool
// invocations, and their results, in the sequence the model produced them.
// A turn like "<think> Let me search → call web_search → <think> Now I'll
// summarize → continue" yields:
//   [{type:'thinking'}, {type:'text'}, {type:'tool_use'}, {type:'tool_result'},
//    {type:'thinking'}, {type:'text'}]
export type TextPart = { type: 'text'; text: string; textHtml?: string };
export type ThinkingPart = { type: 'thinking'; text: string; textHtml?: string };
export type ToolUsePart = {
	type: 'tool_use';
	id: string;
	name: string;
	input: JsonValue;
	inputHtml?: string;
	thoughtSignature?: string;
	startedAt?: number;
};
export type ToolResultPart = {
	type: 'tool_result';
	toolUseId: string;
	content: string | ToolResultBlock[];
	isError: boolean;
	streaming?: boolean;
	startedAt?: number;
	endedAt?: number;
};
export type InfoPart = { type: 'info'; text: string };
// Surface citations (e.g. from `web_search`) as a dedicated part so the UI
// can render a "Sources" block at the spot they were emitted. Mirrors
// `ToolCitation` in `src/lib/server/tools/registry.ts`; declared here so
// client code can import it without crossing the server-only boundary.
export type Citation = { url: string; title: string; snippet?: string };
export type CitationsPart = { type: 'citations'; citations: Citation[] };
export type MessagePart = TextPart | ThinkingPart | ToolUsePart | ToolResultPart | InfoPart | CitationsPart;

export type MessageRow = {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	contentHtml?: string | null;
	thinking?: string | null;
	thinkingHtml?: string | null;
	model: string | null;
	status: 'complete' | 'streaming' | 'error';
	error: string | null;
	createdAt: number;
	meta: MetaSnapshot | null;
	artifacts?: Artifact[];
	parts?: MessagePart[];
};

export type ConversationState = {
	messages: MessageRow[];
	inProgress: { messageId: string; content: string } | null;
};

export type AddMessageResult = { status: 'started' } | { status: 'busy' } | { status: 'invalid'; reason: string };
