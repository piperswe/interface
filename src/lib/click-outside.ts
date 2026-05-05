// Svelte action that calls `handler` when a pointerdown event fires outside
// the element it's attached to, or when Escape is pressed while focus is
// inside it. Used to close `<details>`-based dropdowns (compose options,
// conversation menu).

export function clickOutside(node: HTMLElement, handler: () => void): { destroy(): void } {
	function onDown(e: PointerEvent) {
		if (!(e.target instanceof Node)) return;
		if (node.contains(e.target)) return;
		handler();
	}
	function onKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (!(e.target instanceof Node)) return;
		if (!node.contains(e.target)) return;
		handler();
	}
	document.addEventListener('pointerdown', onDown);
	document.addEventListener('keydown', onKey);
	return {
		destroy() {
			document.removeEventListener('pointerdown', onDown);
			document.removeEventListener('keydown', onKey);
		},
	};
}
