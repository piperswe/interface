import type { MessageRow } from '../../types/conversation';
import { Artifact } from './Artifact';
import { MetaPanel } from './MetaPanel';
import { ToolCallList } from './ToolCall';

export function Message({ message }: { message: MessageRow }) {
	const isAssistant = message.role === 'assistant';
	// Markdown is pre-rendered server-side (Shiki + KaTeX) and shipped as
	// `contentHtml`. Streaming messages don't have it yet — render as plain
	// text. On generation completion the DO broadcasts `refresh` and the page
	// reloads with the fully-rendered HTML.
	const showHtml = isAssistant && typeof message.contentHtml === 'string' && message.contentHtml.length > 0;
	const artifacts = message.artifacts ?? [];
	const toolCalls = message.toolCalls ?? [];
	const toolResults = message.toolResults ?? [];
	return (
		<div className="message" data-message-id={message.id} data-role={message.role} data-status={message.status}>
			<div className="role">
				{message.role}
				{message.model ? ` · ${message.model}` : ''}
			</div>
			{isAssistant && message.thinking && message.thinking.length > 0 ? (
				<details className="thinking">
					<summary>Thinking</summary>
					{typeof message.thinkingHtml === 'string' && message.thinkingHtml.length > 0 ? (
						<div className="thinking-body" dangerouslySetInnerHTML={{ __html: message.thinkingHtml }} />
					) : (
						<div className="thinking-body" style={{ whiteSpace: 'pre-wrap' }}>
							{message.thinking}
						</div>
					)}
				</details>
			) : null}
			{toolCalls.length > 0 ? <ToolCallList toolCalls={toolCalls} toolResults={toolResults} /> : null}
			{showHtml ? (
				<div className="content" dangerouslySetInnerHTML={{ __html: message.contentHtml as string }} />
			) : (
				<div className="content" style={{ whiteSpace: 'pre-wrap' }}>
					{message.content}
				</div>
			)}
			{artifacts.length > 0 ? (
				<div className="artifacts">
					{artifacts.map((a) => (
						<Artifact key={a.id} artifact={a} />
					))}
				</div>
			) : null}
			{message.status === 'error' && message.error ? <div className="error">{message.error}</div> : null}
			{isAssistant ? <MetaPanel snapshot={message.meta} /> : null}
		</div>
	);
}
