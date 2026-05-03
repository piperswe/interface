import { Document, type Theme } from '../../Document';
import { AppShell } from '../../components/AppShell';
import { renderHtml } from '../../render';
import type { Conversation } from '../../../types/conversation';

// The standalone "/" page is now a small empty-state — the sidebar in AppShell
// owns conversation navigation, so the main content area just invites the
// operator to start a new chat.
export function IndexPage() {
	return (
		<div className="empty-state">
			<h1>Start a new chat</h1>
			<p>Pick a conversation from the sidebar, or start fresh.</p>
			<form action="/conversations" method="post">
				<button type="submit" className="primary">
					New chat
				</button>
			</form>
		</div>
	);
}

export async function renderIndexPage(
	conversations: Conversation[],
	options: { theme?: Theme } = {},
): Promise<ReadableStream<Uint8Array>> {
	return renderHtml(
		<Document title="Interface" theme={options.theme}>
			<AppShell conversations={conversations}>
				<IndexPage />
			</AppShell>
		</Document>,
	);
}
