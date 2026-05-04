// Helpers for SvelteKit remote-function `form().enhance(...)` callbacks. The
// vast majority of forms in this app only need to await `submit()`; a smaller
// set wants a confirm() prompt before submitting. Centralised here so the
// pattern doesn't proliferate inline across pages.

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
