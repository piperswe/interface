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

/**
 * Optimistic submit helper. Calls `apply` immediately to mutate local UI state,
 * then submits; if the submit rejects, calls `revert` and shows an error toast.
 * On success an optional toast can be shown.
 */
export function optimisticSubmit(opts: {
	apply: () => void;
	revert: () => void;
	successMessage?: string;
}) {
	return async ({ submit }: { submit: Submit }) => {
		opts.apply();
		try {
			await submit();
			if (opts.successMessage) pushToast(opts.successMessage, 'success');
		} catch (e) {
			opts.revert();
			pushToast(e instanceof Error ? e.message : String(e), 'error');
		}
	};
}

/** Confirm, then run an optimistic submit. */
export function confirmOptimisticSubmit(
	confirmMessage: string,
	opts: { apply: () => void; revert: () => void; successMessage?: string },
) {
	return async ({ submit }: { submit: Submit }) => {
		if (!confirm(confirmMessage)) return;
		opts.apply();
		try {
			await submit();
			if (opts.successMessage) pushToast(opts.successMessage, 'success');
		} catch (e) {
			opts.revert();
			pushToast(e instanceof Error ? e.message : String(e), 'error');
		}
	};
}
