// Helpers for SvelteKit remote-function `form().enhance(...)` callbacks. The
// vast majority of forms in this app only need to await `submit()`; a smaller
// set wants a confirm() prompt before submitting, and the save-and-toast
// pattern wants user-visible confirmation after the redirect lands.
// Centralised here so the pattern doesn't proliferate inline across pages.

import type { RemoteQueryUpdate } from '@sveltejs/kit';
import { pushToast } from './toasts';

type Submit = () => Promise<boolean> & { updates: (...updates: RemoteQueryUpdate[]) => Promise<boolean> };

export const justSubmit = async ({ submit }: { submit: Submit }) => {
	try {
		await submit();
	} catch (e) {
		pushToast(e instanceof Error ? e.message : String(e), 'error');
	}
};

export function confirmSubmit(message: string) {
	return async ({ submit }: { submit: Submit }) => {
		if (!confirm(message)) return;
		try {
			await submit();
		} catch (e) {
			pushToast(e instanceof Error ? e.message : String(e), 'error');
		}
	};
}

/** Submit + push a success toast after the redirect lands. */
export function toastSubmit(successMessage: string) {
	return async ({ submit }: { submit: Submit }) => {
		try {
			await submit();
			pushToast(successMessage, 'success');
		} catch (e) {
			pushToast(e instanceof Error ? e.message : String(e), 'error');
		}
	};
}

/** Confirm + submit + push a success toast. */
export function confirmToastSubmit(confirmMessage: string, successMessage: string) {
	return async ({ submit }: { submit: Submit }) => {
		if (!confirm(confirmMessage)) return;
		try {
			await submit();
			pushToast(successMessage, 'success');
		} catch (e) {
			pushToast(e instanceof Error ? e.message : String(e), 'error');
		}
	};
}
