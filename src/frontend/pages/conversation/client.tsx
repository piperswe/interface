import { hydrateRoot } from 'react-dom/client';
import { AppShell } from '../../components/AppShell';
import { ConversationPage, type ConversationPageProps } from './Page';

declare global {
	interface Window {
		__PROPS__: ConversationPageProps;
	}
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

const props = window.__PROPS__;
hydrateRoot(
	root,
	<AppShell conversations={props.conversations} activeConversationId={props.conversation.id}>
		<ConversationPage {...props} />
	</AppShell>,
);
