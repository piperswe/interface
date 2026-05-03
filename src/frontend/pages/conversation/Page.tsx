import { useState } from 'react';
import type { Conversation, ConversationState } from '../../../types/conversation';
import type { ModelEntry } from '../../../openrouter/models';
import { ComposeForm } from '../../components/ComposeForm';
import { Message } from '../../components/Message';
import { useConversationStream } from '../../hooks/useConversationStream';

export type ConversationPageProps = {
	conversation: Conversation;
	models: ModelEntry[];
	initialState: ConversationState;
};

export function ConversationPage({ conversation, models, initialState }: ConversationPageProps) {
	const [state, setState] = useState<ConversationState>(initialState);
	useConversationStream(conversation.id, setState);

	const busy = state.inProgress !== null;
	const lastModel =
		state.messages.findLast?.((m) => m.role === 'assistant' && m.model)?.model ?? models[0]?.slug ?? '';

	return (
		<>
			<header>
				<h1>{conversation.title}</h1>
				<a href="/">All conversations</a>
			</header>
			{state.messages.length === 0 ? (
				<div className="empty">No messages yet — send the first one below.</div>
			) : (
				<div className="messages">
					{state.messages.map((m) => (
						<Message key={m.id} message={m} />
					))}
				</div>
			)}
			<ComposeForm conversationId={conversation.id} models={models} defaultModel={lastModel} busy={busy} />
		</>
	);
}
