import { renderMarkdown } from '../../markdown';
import { createMetaPanel, type MetaPanel, type MetaSnapshot } from '../../meta';

const conversationId = document.body.dataset.conversationId;
if (!conversationId) throw new Error('Missing conversation id');

const messageContents = new Map<string, string>();
const metaPanels = new Map<string, MetaPanel>();

function findContent(messageId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-message-id="${messageId}"] .content`);
}

function messageEl(messageId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`.message[data-message-id="${messageId}"]`);
}

function ensureMetaPanel(messageId: string): MetaPanel | null {
	const existing = metaPanels.get(messageId);
	if (existing) return existing;
	const parent = messageEl(messageId);
	if (!parent) return null;
	let aside = parent.querySelector<HTMLElement>('aside.meta-panel');
	if (!aside) {
		aside = document.createElement('aside');
		aside.className = 'meta-panel';
		aside.dataset.messageId = messageId;
		parent.appendChild(aside);
	}
	const panel = createMetaPanel(aside);
	metaPanels.set(messageId, panel);
	return panel;
}

function hydrateExistingMessages() {
	for (const el of document.querySelectorAll<HTMLElement>('.message[data-role="assistant"] .content')) {
		const message = el.closest<HTMLElement>('.message');
		const id = message?.dataset.messageId;
		if (!id) continue;
		const original = el.dataset.originalContent ?? '';
		messageContents.set(id, original);
	}
	for (const el of document.querySelectorAll<HTMLElement>('aside.meta-panel[data-meta]')) {
		const id = el.dataset.messageId;
		const raw = el.dataset.meta;
		if (!id || !raw) continue;
		try {
			const snapshot = JSON.parse(raw) as MetaSnapshot;
			const panel = createMetaPanel(el);
			metaPanels.set(id, panel);
			panel.render(snapshot);
		} catch {
			/* ignore */
		}
	}
}

let pendingFlush = false;
const dirtyMessages = new Set<string>();

function flushPending() {
	pendingFlush = false;
	for (const id of dirtyMessages) {
		const el = findContent(id);
		if (!el) continue;
		const full = messageContents.get(id) ?? '';
		const message = messageEl(id);
		if (message?.dataset.role === 'assistant') {
			el.innerHTML = renderMarkdown(full);
		} else {
			el.textContent = full;
		}
	}
	dirtyMessages.clear();
}

function scheduleFlush(messageId: string) {
	dirtyMessages.add(messageId);
	if (pendingFlush) return;
	pendingFlush = true;
	requestAnimationFrame(flushPending);
}

hydrateExistingMessages();

const es = new EventSource(`/c/${conversationId}/events`);

es.addEventListener('sync', (event) => {
	const data = JSON.parse(event.data) as { lastMessageId: string; lastMessageStatus: string; lastMessageContent: string };
	const el = messageEl(data.lastMessageId);
	if (!el || el.dataset.status !== data.lastMessageStatus) {
		location.reload();
		return;
	}
	if (data.lastMessageStatus === 'streaming') {
		messageContents.set(data.lastMessageId, data.lastMessageContent);
		scheduleFlush(data.lastMessageId);
	}
});

es.addEventListener('delta', (event) => {
	const data = JSON.parse(event.data) as { messageId: string; content: string };
	const prior = messageContents.get(data.messageId) ?? '';
	messageContents.set(data.messageId, prior + data.content);
	scheduleFlush(data.messageId);
});

es.addEventListener('meta', (event) => {
	const data = JSON.parse(event.data) as { messageId: string; snapshot: MetaSnapshot };
	const panel = ensureMetaPanel(data.messageId);
	if (panel) panel.render(data.snapshot);
});

es.addEventListener('refresh', () => {
	location.reload();
});
