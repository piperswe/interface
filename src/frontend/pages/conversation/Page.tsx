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
	thinkingBudget?: number | null;
};

export function ConversationPage({ conversation, models, initialState, thinkingBudget }: ConversationPageProps) {
	const [state, setState] = useState<ConversationState>(initialState);
	useConversationStream(conversation.id, setState);

	const busy = state.inProgress !== null;
	const lastModel =
		state.messages.findLast?.((m) => m.role === 'assistant' && m.model)?.model ?? models[0]?.slug ?? '';

	return (
		<>
			<header>
				<h1>{conversation.title}</h1>
				<div style={{ display: 'flex', gap: '0.75rem' }}>
					<a href="/">All conversations</a>
					<a href="/settings">Settings</a>
				</div>
			</header>
			<details className="thinking-budget" style={{ marginBottom: '0.75rem' }}>
				<summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
					Thinking budget: {thinkingBudget && thinkingBudget > 0 ? `${thinkingBudget} tokens` : 'off'}
				</summary>
				<form
					action={`/c/${conversation.id}/thinking-budget`}
					method="post"
					style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}
				>
					<input
						type="number"
						name="budget"
						min={0}
						step={1024}
						placeholder="0 = off"
						defaultValue={thinkingBudget ?? 0}
						style={{ flex: 1 }}
					/>
					<button type="submit">Save</button>
				</form>
			</details>
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
