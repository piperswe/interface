// Helpers for SvelteKit remote-function `form().enhance(...)` callbacks. The
// vast majority of forms in this app only need to await `submit()`; a smaller
// set wants a confirm() prompt before submitting. Centralised here so the
// pattern doesn't proliferate inline across pages.
//
// The `*Toast` variants additionally push a transient notification on success
// or failure — used on the Settings page so the user gets confirmation that
// their change took effect (the post-submit redirect re-renders the form,
// which would otherwise look like nothing happened).

import { pushToast } from './toasts';

type Submit = () => Promise<unknown>;

export const justSubmit = async ({ submit }: { submit: Submit }) => {
	await submit();
};

export function confirmSubmit(message: string) {
	return async ({ submit }: { submit: Submit }) => {
		if (!confirm(message)) return;
		await submit();
	};
}

export function justSubmitToast(successMessage = 'Saved', errorMessage = 'Failed to save') {
	return async ({ submit }: { submit: Submit }) => {
		try {
			await submit();
			pushToast(successMessage, 'success');
		} catch (e) {
			pushToast(errorMessage, 'error');
			throw e;
		}
	};
}

export function confirmSubmitToast(
	prompt: string,
	successMessage = 'Done',
	errorMessage = 'Failed',
) {
	return async ({ submit }: { submit: Submit }) => {
		if (!confirm(prompt)) return;
		try {
			await submit();
			pushToast(successMessage, 'success');
		} catch (e) {
			pushToast(errorMessage, 'error');
			throw e;
		}
	};
}
