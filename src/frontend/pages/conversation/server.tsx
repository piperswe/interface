import { renderToReadableStream } from 'react-dom/server';
import { Layout } from '../../Layout';
import { renderMarkdown } from '../../markdown';
import type { Conversation } from '../../../conversations';
import type { ConversationState, MessageRow } from '../../../durable_objects/ConversationDurableObject';
import type { ModelEntry } from '../../../openrouter/models';

export type ConversationPageProps = {
	conversation: Conversation;
	state: ConversationState;
	models: ModelEntry[];
};

function MessageContent({ message }: { message: MessageRow }) {
	if (message.role === 'assistant') {
		return (
			<div
				className="content"
				data-original-content={message.content}
				dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
			/>
		);
	}
	return <div className="content" style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>;
}

export function ConversationPage({ conversation, state, models }: ConversationPageProps) {
	const busy = state.inProgress !== null;
	const lastModel = state.messages.findLast?.((m) => m.role === 'assistant' && m.model)?.model ?? models[0]?.slug ?? '';
	return (
		<Layout
			title={conversation.title}
			bodyClass="conversation"
			bodyAttrs={{ 'data-conversation-id': conversation.id }}
			scriptSrc="/dist/conversation.js"
		>
			<header>
				<h1>{conversation.title}</h1>
				<a href="/">All conversations</a>
			</header>
			{state.messages.length === 0 ? (
				<div className="empty">No messages yet — send the first one below.</div>
			) : (
				<div className="messages">
					{state.messages.map((m) => (
						<div key={m.id} className="message" data-message-id={m.id} data-role={m.role} data-status={m.status}>
							<div className="role">
								{m.role}
								{m.model ? ` · ${m.model}` : ''}
							</div>
							<MessageContent message={m} />
							{m.status === 'error' && m.error ? <div className="error">{m.error}</div> : null}
							{m.role === 'assistant' && m.status === 'complete' && m.meta ? (
								<aside className="meta-panel" data-message-id={m.id} data-meta={JSON.stringify(m.meta)} />
							) : null}
						</div>
					))}
				</div>
			)}
			<form className="compose" action={`/c/${conversation.id}/messages`} method="post">
				<div className="row">
					<select id="model" name="model" defaultValue={lastModel}>
						{models.map((m) => (
							<option key={m.slug} value={m.slug}>
								{m.label}
							</option>
						))}
					</select>
					<textarea name="content" placeholder="Type a message..." required disabled={busy} />
				</div>
				<button type="submit" disabled={busy}>
					{busy ? 'Generating…' : 'Send'}
				</button>
			</form>
		</Layout>
	);
}

export async function renderConversationPage(props: ConversationPageProps): Promise<ReadableStream> {
	const el = <ConversationPage {...props} />;
	return await renderToReadableStream(el);
}
