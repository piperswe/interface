import type { MessageRow } from '../../types/conversation';
import { renderMarkdown } from '../markdown';
import { MetaPanel } from './MetaPanel';

export function Message({ message }: { message: MessageRow }) {
	return (
		<div className="message" data-message-id={message.id} data-role={message.role} data-status={message.status}>
			<div className="role">
				{message.role}
				{message.model ? ` · ${message.model}` : ''}
			</div>
			{message.role === 'assistant' ? (
				<div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
			) : (
				<div className="content" style={{ whiteSpace: 'pre-wrap' }}>
					{message.content}
				</div>
			)}
			{message.status === 'error' && message.error ? <div className="error">{message.error}</div> : null}
			{message.role === 'assistant' ? <MetaPanel snapshot={message.meta} /> : null}
		</div>
	);
}
