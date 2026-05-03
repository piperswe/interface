import { hydrateRoot } from 'react-dom/client';
import { ConversationPage, type ConversationPageProps } from './Page';

declare global {
	interface Window {
		__PROPS__: ConversationPageProps;
	}
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

hydrateRoot(root, <ConversationPage {...window.__PROPS__} />);
