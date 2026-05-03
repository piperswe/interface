import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const NEAR_BOTTOM_PX = 80;

// Pin a scrollable container to its bottom across renders, but only when the
// user is already near the bottom. Lets the operator scroll up to read history
// without the chat yanking them back down on each delta.
//
// Pass a ref to the scroll container and the dependency that signals "content
// changed" (typically the messages list / ConversationState).
export function useStickyScroll(
	containerRef: RefObject<HTMLElement | null>,
	contentSignal: unknown,
): void {
	const stickToBottom = useRef(true);

	// On mount: jump to the bottom synchronously so the first paint shows the
	// latest message rather than the top of the conversation.
	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		stickToBottom.current = true;
	}, [containerRef]);

	// Track whether the user is near the bottom. When they scroll up away from
	// the bottom, stop pinning.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onScroll = () => {
			const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
			stickToBottom.current = distance <= NEAR_BOTTOM_PX;
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	}, [containerRef]);

	// On every content-signal change: if pinned, snap to bottom after the DOM
	// updates. Use rAF so we measure post-layout.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		if (!stickToBottom.current) return;
		const handle = requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
		});
		return () => cancelAnimationFrame(handle);
	}, [containerRef, contentSignal]);
}
