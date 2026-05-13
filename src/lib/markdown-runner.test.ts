import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationState, MessagePart, MessageRow, TextPart } from '$lib/types/conversation';
import { assertDefined } from '../../test/assert-defined';
import { createMarkdownRunner } from './markdown-runner';

// Markdown rendering is exercised in markdown.client.test.ts; stub it here so
// the runner's scheduling/caching is tested in isolation.
vi.mock('./markdown.client', () => ({
	renderArtifactCodeClient: vi.fn(async (code: string) => `<pre>${code}</pre>`),
	renderMarkdownClient: vi.fn(async (text: string) => `<p>${text}</p>`),
}));

let rafQueue: FrameRequestCallback[] = [];

beforeEach(() => {
	rafQueue = [];
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		rafQueue.push(cb);
		return rafQueue.length;
	});
	vi.stubGlobal('cancelAnimationFrame', (_handle: number) => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
	// Drain the rAF queue and any microtasks the renders queue. A handful of
	// passes is enough — `pulse()` only re-arms when an in-flight render lands.
	for (let i = 0; i < 8; i++) {
		const queued = rafQueue;
		rafQueue = [];
		for (const cb of queued) cb(performance.now());
		await Promise.resolve();
		await Promise.resolve();
	}
}

function makeState(parts: MessagePart[]): ConversationState {
	const message: MessageRow = {
		content: '',
		createdAt: 0,
		error: null,
		id: 'm1',
		meta: null,
		model: 'test/model',
		parts,
		role: 'assistant',
		status: 'complete',
	};
	return { inProgress: null, messages: [message] };
}

describe('createMarkdownRunner', () => {
	it('renders missing textHtml on first pulse', async () => {
		let state = makeState([{ text: 'hello', type: 'text' }]);
		const runner = createMarkdownRunner(
			() => state,
			(next) => {
				state = next;
			},
		);
		runner.pulse();
		await flush();
		assertDefined(state.messages[0].parts);
		const part = state.messages[0].parts[0] as TextPart;
		expect(part.textHtml).toBe('<p>hello</p>');
		runner.dispose();
	});

	// Regression: when the page reloads after a message completes
	// (`refresh` SSE event → invalidateAll), the server-shipped state has
	// `textHtml` stripped — the wire format never carries pre-rendered HTML.
	// The runner used to short-circuit because its cache said "this revision
	// is already rendered", leaving the UI to fall back to plain markdown.
	it('re-renders after textHtml is stripped between pulses', async () => {
		let state = makeState([{ text: 'hello', type: 'text' }]);
		const runner = createMarkdownRunner(
			() => state,
			(next) => {
				state = next;
			},
		);
		runner.pulse();
		await flush();
		assertDefined(state.messages[0].parts);
		expect((state.messages[0].parts[0] as TextPart).textHtml).toBe('<p>hello</p>');

		// Same text content, no textHtml — what arrives after invalidateAll().
		state = makeState([{ text: 'hello', type: 'text' }]);
		runner.pulse();
		await flush();
		assertDefined(state.messages[0].parts);
		expect((state.messages[0].parts[0] as TextPart).textHtml).toBe('<p>hello</p>');
		runner.dispose();
	});

	it('skips re-render when textHtml is already present and text is unchanged', async () => {
		const { renderMarkdownClient } = await import('./markdown.client');
		const renderSpy = vi.mocked(renderMarkdownClient);
		renderSpy.mockClear();

		let state = makeState([{ text: 'hello', type: 'text' }]);
		const runner = createMarkdownRunner(
			() => state,
			(next) => {
				state = next;
			},
		);
		runner.pulse();
		await flush();
		expect(renderSpy).toHaveBeenCalledTimes(1);

		// Same text, textHtml already set — runner should not re-render.
		runner.pulse();
		await flush();
		expect(renderSpy).toHaveBeenCalledTimes(1);
		runner.dispose();
	});
});
