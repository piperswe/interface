// Lightweight transient-notification store. The settings page (and anywhere
// else that wants user-visible save confirmation) calls `pushToast(...)`;
// the `<Toaster>` component mounted in the root layout subscribes and renders.

import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error';

export type Toast = {
	id: number;
	message: string;
	type: ToastType;
};

const DEFAULT_TIMEOUT_MS = 3000;

const toastsStore = writable<Toast[]>([]);
let nextId = 0;

export function pushToast(message: string, type: ToastType = 'success', timeoutMs = DEFAULT_TIMEOUT_MS): number {
	const id = ++nextId;
	toastsStore.update((arr) => [...arr, { id, message, type }]);
	if (timeoutMs > 0) {
		setTimeout(() => dismissToast(id), timeoutMs);
	}
	return id;
}

export function dismissToast(id: number): void {
	toastsStore.update((arr) => arr.filter((t) => t.id !== id));
}

export const toasts = { subscribe: toastsStore.subscribe };
