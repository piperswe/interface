// Svelte action that calls `handler` when a pointerdown event fires outside
// the element it's attached to. Used to close `<details>`-based dropdowns
// (compose options, conversation menu) when the user clicks elsewhere.

export function clickOutside(node: HTMLElement, handler: () => void): { destroy(): void } {
	function onDown(e: PointerEvent) {
		if (!(e.target instanceof Node)) return;
		if (node.contains(e.target)) return;
		handler();
	}
	document.addEventListener('pointerdown', onDown);
	return {
		destroy() {
			document.removeEventListener('pointerdown', onDown);
		},
	};
}
