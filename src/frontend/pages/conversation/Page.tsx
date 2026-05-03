import { useMemo, useRef, useState } from 'react';
import type { Conversation, ConversationState } from '../../../types/conversation';
import type { ModelEntry } from '../../../models/config';
import { ComposeForm } from '../../components/ComposeForm';
import { Message } from '../../components/Message';
import { useConversationStream } from '../../hooks/useConversationStream';
import { useStickyScroll } from '../../hooks/useStickyScroll';
import { useStreamingMarkdown } from '../../hooks/useStreamingMarkdown';
import { fmtCost } from '../../formatters';

export type ConversationPageProps = {
	conversation: Conversation;
	models: ModelEntry[];
	initialState: ConversationState;
	thinkingBudget?: number | null;
	conversations: Conversation[];
};

export function ConversationPage({ conversation, models, initialState, thinkingBudget }: ConversationPageProps) {
	const [state, setState] = useState<ConversationState>(initialState);
	useConversationStream(conversation.id, setState);
	useStreamingMarkdown(state, setState);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	useStickyScroll(scrollRef, state);

	const busy = state.inProgress !== null;
	const lastModel =
		state.messages.findLast?.((m) => m.role === 'assistant' && m.model)?.model ?? models[0]?.slug ?? '';

	const totalCost = useMemo(() => {
		let sum = 0;
		for (const m of state.messages) {
			if (m.role !== 'assistant' || !m.meta) continue;
			const cost = m.meta.generation?.totalCost ?? m.meta.usage?.cost;
			if (typeof cost === 'number') sum += cost;
		}
		return sum;
	}, [state.messages]);

	return (
		<div className="conversation-layout">
			<div className="conversation-header">
				<h1 className="conversation-title">{conversation.title}</h1>
				<form action={`/c/${conversation.id}/regenerate-title`} method="post" className="title-action">
					<button type="submit" title="Regenerate title" disabled={busy} className="title-action-button">
						↻
					</button>
				</form>
				{totalCost > 0 ? <span className="conversation-cost">Cost: {fmtCost(totalCost)}</span> : null}
				<details className="thinking-budget">
					<summary>
						Thinking budget: {thinkingBudget && thinkingBudget > 0 ? `${thinkingBudget} tokens` : 'off'}
					</summary>
					<form action={`/c/${conversation.id}/thinking-budget`} method="post" className="thinking-budget-form">
						<input
							type="number"
							name="budget"
							min={0}
							step={1024}
							placeholder="0 = off"
							defaultValue={thinkingBudget ?? 0}
						/>
						<button type="submit">Save</button>
					</form>
				</details>
			</div>
			<div ref={scrollRef} className="conversation-scroll">
				<div className="conversation-column">
					{state.messages.length === 0 ? (
						<div className="empty">No messages yet — send the first one below.</div>
					) : (
						<div className="messages">
							{state.messages.map((m) => (
								<Message key={m.id} message={m} />
							))}
						</div>
					)}
				</div>
			</div>
			<div className="conversation-compose">
				<div className="conversation-column">
					<ComposeForm conversationId={conversation.id} models={models} defaultModel={lastModel} busy={busy} />
				</div>
			</div>
		</div>
	);
}
