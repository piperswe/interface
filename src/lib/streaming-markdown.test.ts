import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationState, MessageRow } from '$lib/types/conversation';
import { createStreamingMarkdownRunner } from './streaming-markdown';

afterEach(() => {
	vi.restoreAllMocks();
});

const baseAssistant: MessageRow = {
	id: 'a1',
	role: 'assistant',
	content: '',
	model: 'm/test',
	status: 'streaming',
	error: null,
	createdAt: 0,
	meta: null,
	thinking: null,
	parts: [],
};

function buildState(...messages: MessageRow[]): ConversationState {
	return { messages, inProgress: null };
}

// `requestAnimationFrame` runs synchronously in workerd's test runtime via
// `setTimeout(0)`, so we install a controllable shim.
function installRafShim() {
	const queue: Array<() => void> = [];
	const orig = globalThis.requestAnimationFrame;
	const origCancel = globalThis.cancelAnimationFrame;
	globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
		const handle = queue.length + 1;
		queue.push(() => cb(performance.now()));
		return handle;
	}) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = ((handle: number) => {
		queue[handle - 1] = () => {};
	}) as typeof cancelAnimationFrame;
	return {
		flush: () => {
			while (queue.length) queue.shift()!();
		},
		restore: () => {
			globalThis.requestAnimationFrame = orig;
			globalThis.cancelAnimationFrame = origCancel;
		},
	};
}

describe('createStreamingMarkdownRunner', () => {
	it('schedules a render that fills textHtml for streaming text parts', async () => {
		const raf = installRafShim();
		try {
			let state = buildState({
				...baseAssistant,
				parts: [{ type: 'text', text: '**bold**' }],
			});
			const runner = createStreamingMarkdownRunner(
				() => state,
				(next) => (state = next),
			);
			runner.pulse();
			raf.flush();
			// Yield microtasks for the marked parser.
			await new Promise((r) => setTimeout(r, 5));
			const part = state.messages[0].parts?.[0];
			expect(part?.type).toBe('text');
			if (part?.type === 'text') {
				expect(typeof part.textHtml).toBe('string');
				expect(part.textHtml).toContain('<strong>bold</strong>');
			}
			runner.dispose();
		} finally {
			raf.restore();
		}
	});

	it('skips parts that already have a textHtml', async () => {
		const raf = installRafShim();
		try {
			let state = buildState({
				...baseAssistant,
				parts: [{ type: 'text', text: 'cached', textHtml: '<p>cached</p>' }],
			});
			const setState = vi.fn((next: ConversationState) => (state = next));
			const runner = createStreamingMarkdownRunner(() => state, setState);
			runner.pulse();
			raf.flush();
			await new Promise((r) => setTimeout(r, 5));
			expect(setState).not.toHaveBeenCalled();
			runner.dispose();
		} finally {
			raf.restore();
		}
	});

	it('skips empty parts and non-assistant messages', async () => {
		const raf = installRafShim();
		try {
			let state = buildState(
				{ ...baseAssistant, role: 'user', parts: [{ type: 'text', text: 'user msg' }] },
				{ ...baseAssistant, parts: [{ type: 'text', text: '' }] },
			);
			const setState = vi.fn((next: ConversationState) => (state = next));
			const runner = createStreamingMarkdownRunner(() => state, setState);
			runner.pulse();
			raf.flush();
			await new Promise((r) => setTimeout(r, 5));
			expect(setState).not.toHaveBeenCalled();
			runner.dispose();
		} finally {
			raf.restore();
		}
	});

	it('coalesces multiple pulses into a single rAF', () => {
		const raf = installRafShim();
		try {
			let state = buildState({ ...baseAssistant, parts: [{ type: 'text', text: 'x' }] });
			const runner = createStreamingMarkdownRunner(
				() => state,
				(next) => (state = next),
			);
			runner.pulse();
			runner.pulse();
			runner.pulse();
			// Only one rAF callback should be queued — we flush and observe.
			let count = 0;
			const origFlush = raf.flush;
			raf.flush = () => {
				count++;
				origFlush();
			};
			origFlush();
			expect(count).toBeLessThanOrEqual(1);
			runner.dispose();
		} finally {
			raf.restore();
		}
	});

	it('dispose() cancels any pending render', () => {
		const raf = installRafShim();
		try {
			let state = buildState({ ...baseAssistant, parts: [{ type: 'text', text: 'unrendered' }] });
			const setState = vi.fn((next: ConversationState) => (state = next));
			const runner = createStreamingMarkdownRunner(() => state, setState);
			runner.pulse();
			runner.dispose();
			raf.flush();
			expect(setState).not.toHaveBeenCalled();
		} finally {
			raf.restore();
		}
	});

	it('does not overwrite a part that mutated mid-render', async () => {
		const raf = installRafShim();
		try {
			let state = buildState({
				...baseAssistant,
				parts: [{ type: 'text', text: 'one' }],
			});
			const runner = createStreamingMarkdownRunner(
				() => state,
				(next) => (state = next),
			);
			runner.pulse();
			raf.flush();
			// Mutate the part text before the marked parser resolves.
			state = buildState({
				...baseAssistant,
				parts: [{ type: 'text', text: 'two' }],
			});
			await new Promise((r) => setTimeout(r, 5));
			const part = state.messages[0].parts?.[0];
			expect(part?.type).toBe('text');
			if (part?.type === 'text') {
				expect(part.text).toBe('two');
				// First pulse rendered "one"; we should NOT see textHtml from
				// the stale render attached to the new text.
				expect(part.textHtml).toBeUndefined();
			}
			runner.dispose();
		} finally {
			raf.restore();
		}
	});
});
