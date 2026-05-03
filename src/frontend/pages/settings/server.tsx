import { Document } from '../../Document';
import { AppShell } from '../../components/AppShell';
import { renderHtml } from '../../render';
import type { Conversation } from '../../../types/conversation';
import { SettingsPage, type SettingsPageProps } from './Page';

export async function renderSettingsPage(
	props: SettingsPageProps,
	options: { conversations: Conversation[] },
): Promise<ReadableStream<Uint8Array>> {
	return renderHtml(
		<Document title="Settings" theme={props.theme}>
			<AppShell conversations={options.conversations}>
				<SettingsPage {...props} />
			</AppShell>
		</Document>,
	);
}
