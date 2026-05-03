import { Document } from '../../Document';
import { renderHtml } from '../../render';
import { SettingsPage, type SettingsPageProps } from './Page';

export async function renderSettingsPage(props: SettingsPageProps): Promise<ReadableStream<Uint8Array>> {
	return renderHtml(
		<Document title="Settings" theme={props.theme}>
			<SettingsPage {...props} />
		</Document>,
	);
}
