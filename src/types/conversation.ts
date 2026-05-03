import type { ChatStreamChunk, ChatUsage, GenerationResponseData } from '@openrouter/sdk/models';

export type Conversation = {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
	thinking_budget?: number | null;
};

export interface MetaSnapshot {
	startedAt: number;
	firstTokenAt: number;
	lastChunk: ChatStreamChunk | null;
	usage: ChatUsage | null;
	generation: GenerationResponseData | null;
}

// Artifact types start at the minimum viable set per Phase 0.5: code (syntax-
// highlighted) and markdown. HTML/JS/SVG/Mermaid land in Phase 4 P0.8 with the
// dedicated *.artifacts.<host> origin for sandboxing.
export type ArtifactType = 'code' | 'markdown';

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
// rejects `unknown` field types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonValue = any;

export type ToolCallRecord = { id: string; name: string; input: JsonValue };
export type ToolResultRecord = { toolUseId: string; content: string; isError: boolean };

export type MessageRow = {
	id: string;
	role: 'user' | 'assistant';
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
	toolCalls?: ToolCallRecord[];
	toolResults?: ToolResultRecord[];
};

export type ConversationState = {
	messages: MessageRow[];
	inProgress: { messageId: string; content: string } | null;
};

export type AddMessageResult = { status: 'started' } | { status: 'busy' } | { status: 'invalid'; reason: string };
