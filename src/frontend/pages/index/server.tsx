import { Document } from '../../Document';
import { renderHtml } from '../../render';
import type { Conversation } from '../../../types/conversation';

function fmtRelative(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
	if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
	return Math.floor(diff / 86_400_000) + 'd ago';
}

export function IndexPage({ conversations }: { conversations: Conversation[] }) {
	return (
		<>
			<header>
				<h1>Conversations</h1>
				<form action="/conversations" method="post">
					<button type="submit">New chat</button>
				</form>
			</header>
			{conversations.length === 0 ? (
				<div className="empty">No conversations yet. Start one above.</div>
			) : (
				<ul className="conversation-list">
					{conversations.map((c) => (
						<li key={c.id}>
							<a href={`/c/${c.id}`}>
								<div className="title">{c.title}</div>
								<div className="meta">{fmtRelative(c.updated_at)}</div>
							</a>
						</li>
					))}
				</ul>
			)}
		</>
	);
}

export async function renderIndexPage(conversations: Conversation[]): Promise<ReadableStream<Uint8Array>> {
	return renderHtml(
		<Document title="Conversations">
			<IndexPage conversations={conversations} />
		</Document>,
	);
}
