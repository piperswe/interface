import { useRef, type FormEvent, type KeyboardEvent } from 'react';
import type { ModelEntry } from '../../models/config';

export type ComposeFormProps = {
	conversationId: string;
	models: ModelEntry[];
	defaultModel: string;
	busy: boolean;
};

export function ComposeForm({ conversationId, models, defaultModel, busy }: ComposeFormProps) {
	const formRef = useRef<HTMLFormElement | null>(null);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter submits, Shift-Enter inserts a newline. Cmd/Ctrl-Enter also submits.
		if (e.key !== 'Enter') return;
		if (e.shiftKey) return;
		if (busy) return;
		e.preventDefault();
		formRef.current?.requestSubmit();
	};

	const onSubmit = (e: FormEvent<HTMLFormElement>) => {
		// Don't gate the native submit when busy; the disabled button already
		// covers that path. This handler exists so future client-side enhancements
		// (optimistic updates, etc.) can hook in.
		if (busy) e.preventDefault();
	};

	return (
		<form ref={formRef} className="compose" action={`/c/${conversationId}/messages`} method="post" onSubmit={onSubmit}>
			<textarea
				name="content"
				placeholder="Send a message…"
				required
				disabled={busy}
				rows={1}
				onKeyDown={onKeyDown}
			/>
			<div className="row">
				<select name="model" defaultValue={defaultModel} aria-label="Model">
					{models.map((m) => (
						<option key={m.slug} value={m.slug}>
							{m.label}
						</option>
					))}
				</select>
				<button type="submit" className="send" disabled={busy} aria-label={busy ? 'Generating…' : 'Send'}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<line x1="12" y1="19" x2="12" y2="5" />
						<polyline points="5 12 12 5 19 12" />
					</svg>
				</button>
			</div>
		</form>
	);
}
