import type { ModelEntry } from '../../openrouter/models';

export type ComposeFormProps = {
	conversationId: string;
	models: ModelEntry[];
	defaultModel: string;
	busy: boolean;
};

export function ComposeForm({ conversationId, models, defaultModel, busy }: ComposeFormProps) {
	return (
		<form className="compose" action={`/c/${conversationId}/messages`} method="post">
			<div className="row">
				<select name="model" defaultValue={defaultModel}>
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
	);
}
