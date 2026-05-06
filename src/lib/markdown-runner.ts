// Renders markdown, code highlighting, and KaTeX entirely client-side.
// Walks the conversation state and fills in `*Html` fields on parts,
// messages, artifacts, and tool calls. The renderer is fully async; one
// scan per animation frame, one in-flight render per (target, revision).

import type {
	Artifact,
	ConversationState,
	JsonValue,
	MessagePart,
	MessageRow,
} from '$lib/types/conversation';

// Start the download immediately (separate chunk, but begins resolving on
// module init so it's ready by the time the first render is needed).
const _markdownMod = import('./markdown.client');

type CacheKey = string;

export type MarkdownRunner = {
	pulse(): void;
	dispose(): void;
};

function partKey(messageId: string, index: number, kind: 'text' | 'input'): CacheKey {
	return `p:${messageId}:${index}:${kind}`;
}

function messageContentKey(messageId: string): CacheKey {
	return `mc:${messageId}`;
}

function messageThinkingKey(messageId: string): CacheKey {
	return `mt:${messageId}`;
}

function artifactKey(id: string, version: number): CacheKey {
	return `a:${id}:${version}`;
}

function toolCallCode(name: string, input: JsonValue): { code: string; language: string } | null {
	const obj = (input ?? {}) as { code?: unknown; language?: unknown };
	if (typeof obj.code !== 'string' || obj.code.length === 0) return null;
	if (name === 'run_js') return { code: obj.code, language: 'javascript' };
	if (name === 'sandbox_run_code') {
		const lang = typeof obj.language === 'string' ? obj.language : 'python';
		return { code: obj.code, language: lang };
	}
	return null;
}

export function createMarkdownRunner(
	getState: () => ConversationState,
	setState: (next: ConversationState) => void,
): MarkdownRunner {
	const renderedRevByKey = new Map<CacheKey, string>();
	const inFlight = new Set<CacheKey>();
	let scheduled = 0;
	let cancelled = false;

	function pulse(): void {
		if (scheduled || cancelled) return;
		scheduled = requestAnimationFrame(() => {
			scheduled = 0;
			if (cancelled) return;
			scan();
		});
	}

	function scan(): void {
		const state = getState();
		// Drop cache entries whose owning message no longer exists.
		const liveMessages = new Set<string>();
		const liveArtifacts = new Set<string>();
		for (const m of state.messages) {
			liveMessages.add(m.id);
			for (const a of m.artifacts ?? []) liveArtifacts.add(a.id);
		}
		for (const key of renderedRevByKey.keys()) {
			if (key.startsWith('a:')) {
				const id = key.split(':')[1];
				if (!liveArtifacts.has(id)) renderedRevByKey.delete(key);
			} else {
				const id = key.split(':')[1];
				if (!liveMessages.has(id)) renderedRevByKey.delete(key);
			}
		}
		for (const m of state.messages) {
			scanMessage(m);
		}
	}

	function scanMessage(m: MessageRow): void {
		if (m.role === 'system') return;
		const hasParts = (m.parts?.length ?? 0) > 0;
		if (hasParts) {
			m.parts!.forEach((part, i) => scanPart(m.id, i, part));
		} else if (m.content) {
			const text = m.content;
			scheduleRender(
				messageContentKey(m.id),
				text,
				m.contentHtml,
				() => _markdownMod.then((m) => m.renderMarkdownClient(text)),
				(html) => applyMessagePatch(m.id, (msg) => ({ ...msg, contentHtml: html })),
			);
		}
		if (m.thinking) {
			const text = m.thinking;
			scheduleRender(
				messageThinkingKey(m.id),
				text,
				m.thinkingHtml,
				() => _markdownMod.then((m) => m.renderMarkdownClient(text)),
				(html) => applyMessagePatch(m.id, (msg) => ({ ...msg, thinkingHtml: html })),
			);
		}
		for (const a of m.artifacts ?? []) {
			scanArtifact(m.id, a);
		}
	}

	function scanPart(messageId: string, index: number, part: MessagePart): void {
		if (part.type === 'text' || part.type === 'thinking') {
			if (!part.text) return;
			const text = part.text;
			const kind = part.type;
			scheduleRender(
				partKey(messageId, index, 'text'),
				text,
				part.textHtml,
				() => _markdownMod.then((m) => m.renderMarkdownClient(text)),
				(html) => {
					applyPartPatch(messageId, index, text, kind, (target) => ({
						...target,
						textHtml: html,
					}));
				},
			);
		} else if (part.type === 'tool_use') {
			const code = toolCallCode(part.name, part.input);
			if (!code) return;
			scheduleRender(
				partKey(messageId, index, 'input'),
				`${code.language}:${code.code}`,
				part.inputHtml,
				() => _markdownMod.then((m) => m.renderArtifactCodeClient(code.code, code.language)),
				(html) => {
					applyPartPatch(messageId, index, code.code, 'tool_use', (target) => {
						if (target.type !== 'tool_use') return target;
						return { ...target, inputHtml: html };
					});
				},
			);
		}
	}

	function scanArtifact(messageId: string, a: Artifact): void {
		if (a.type !== 'code' && a.type !== 'markdown' && a.type !== 'svg') return;
		const key = artifactKey(a.id, a.version);
		const render =
			a.type === 'code'
				? () => _markdownMod.then((m) => m.renderArtifactCodeClient(a.content, a.language ?? 'text'))
				: a.type === 'markdown'
					? () => _markdownMod.then((m) => m.renderMarkdownClient(a.content))
					: async () => a.content;
		scheduleRender(key, a.content, a.contentHtml, render, (html) => {
			applyArtifactPatch(messageId, a.id, a.version, html);
		});
	}

	// `currentHtml` is the rendered output already present on the target. The
	// cache short-circuit only applies when the output is still attached —
	// otherwise a state reload that strips `*Html` (server doesn't ship
	// pre-rendered HTML over the wire) would leave parts un-rendered, since
	// the cache thinks "we've already rendered this revision".
	function scheduleRender(
		key: CacheKey,
		revision: string,
		currentHtml: string | null | undefined,
		render: () => Promise<string>,
		apply: (html: string) => void,
	): void {
		if (currentHtml != null && renderedRevByKey.get(key) === revision) return;
		if (inFlight.has(key)) return;
		inFlight.add(key);
		const work = (async () => {
			let html: string;
			try {
				html = await render();
			} catch {
				return;
			}
			if (cancelled) return;
			renderedRevByKey.set(key, revision);
			apply(html);
		})();
		void work.finally(() => {
			inFlight.delete(key);
			pulse();
		});
	}

	function applyMessagePatch(messageId: string, patch: (m: MessageRow) => MessageRow): void {
		const prev = getState();
		let touched = false;
		const messages = prev.messages.map((m) => {
			if (m.id !== messageId) return m;
			touched = true;
			return patch(m);
		});
		if (touched) setState({ ...prev, messages });
	}

	function applyPartPatch(
		messageId: string,
		index: number,
		expectedText: string,
		expectedType: MessagePart['type'],
		patch: (target: MessagePart) => MessagePart,
	): void {
		const prev = getState();
		let touched = false;
		const messages = prev.messages.map((m) => {
			if (m.id !== messageId || !m.parts) return m;
			const next = m.parts.slice();
			const target = next[index];
			if (!target || target.type !== expectedType) return m;
			if (target.type === 'text' || target.type === 'thinking') {
				if (target.text !== expectedText) return m;
			}
			next[index] = patch(target);
			touched = true;
			return { ...m, parts: next };
		});
		if (touched) setState({ ...prev, messages });
	}

	function applyArtifactPatch(messageId: string, artifactId: string, expectedVersion: number, html: string): void {
		const prev = getState();
		let touched = false;
		const messages = prev.messages.map((m) => {
			if (m.id !== messageId || !m.artifacts) return m;
			const artifacts = m.artifacts.map((a) => {
				if (a.id !== artifactId || a.version !== expectedVersion) return a;
				touched = true;
				return { ...a, contentHtml: html };
			});
			return touched ? { ...m, artifacts } : m;
		});
		if (touched) setState({ ...prev, messages });
	}

	return {
		pulse,
		dispose() {
			cancelled = true;
			if (scheduled) cancelAnimationFrame(scheduled);
		},
	};
}
