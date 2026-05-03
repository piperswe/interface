import type { ChatStreamChunk, ChatUsage, GenerationResponseData } from '@openrouter/sdk/esm/models';

export type Conversation = {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
};

export interface MetaSnapshot {
	startedAt: number;
	firstTokenAt: number;
	lastChunk: ChatStreamChunk | null;
	usage: ChatUsage | null;
	generation: GenerationResponseData | null;
}

export type MessageRow = {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	model: string | null;
	status: 'complete' | 'streaming' | 'error';
	error: string | null;
	createdAt: number;
	meta: MetaSnapshot | null;
};

export type ConversationState = {
	messages: MessageRow[];
	inProgress: { messageId: string; content: string } | null;
};

export type AddMessageResult = { status: 'started' } | { status: 'busy' } | { status: 'invalid'; reason: string };
