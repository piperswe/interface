import { Document } from '../../Document';
import { renderHtml, serializeProps } from '../../render';
import { ConversationPage, type ConversationPageProps } from './Page';

export async function renderConversationPage(props: ConversationPageProps): Promise<ReadableStream<Uint8Array>> {
	return renderHtml(
		<Document title={props.conversation.title} bodyClass="conversation">
			<ConversationPage {...props} />
		</Document>,
		{
			bootstrapModules: ['/dist/conversation.js'],
			bootstrapScriptContent: `window.__PROPS__=${serializeProps(props)};`,
		},
	);
}
