import { command, form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { archiveConversation, createConversation, deleteConversation, unarchiveConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

function stubFor(id: string) {
	if (!CONVERSATION_ID_PATTERN.test(id)) error(400, `invalid conversation id: ${id}`);
	return getConversationStub(getEnv(), id);
}

// Command: start a new conversation. Returns the new id so the caller can
// `goto(`/c/${id}`)` for an in-place SPA navigation. Bound to "New chat"
// buttons throughout the app. Accepts an optional client-pre-allocated id so
// the UI can navigate optimistically while the row is created in the
// background.
export const createNewConversation = command('unchecked', async (input: { id?: string } | void) => {
	const env = getEnv();
	const requested = input && typeof input.id === 'string' ? input.id : null;
	if (requested != null && !CONVERSATION_ID_PATTERN.test(requested)) {
		error(400, `invalid conversation id: ${requested}`);
	}
	const id = await createConversation(env, requested ?? undefined);
	return { id };
});

// Form: send a user message into a conversation. Per-conversation instance via
// `.for(conversationId)` — that namespaces the form so result/pending state
// doesn't bleed between concurrent forms.
//
// `attachments_trailer` is appended to `content` server-side; the compose
// form pre-builds it from completed uploads (paths under /workspace/) so the
// model sees them in its view of the user message. Splitting it from
// `content` lets the textarea remain a clean reflection of what the user
// typed while the trailer rides along to the LLM.
export const sendMessage = form(
	'unchecked',
	async (data: { conversationId?: unknown; content?: unknown; model?: unknown; attachments_trailer?: unknown }) => {
		const conversationId = String(data.conversationId ?? '');
		const baseContent = String(data.content ?? '');
		const trailer = String(data.attachments_trailer ?? '');
		const content = trailer ? baseContent + trailer : baseContent;
		const model = String(data.model ?? '');
		const stub = stubFor(conversationId);
		const result = await stub.addUserMessage(conversationId, content, model);
		if (result.status === 'busy') {
			error(409, 'Conversation busy: a generation is already in progress');
		}
		if (result.status === 'invalid') {
			error(400, `Invalid: ${result.reason}`);
		}
		return { ok: true as const };
	},
);

// Command form of sendMessage for callers that can't use a real <form>
// — specifically the conversational-mode controller, which sends voice
// turns from JS without going through the textarea form. Mirrors the
// validation the form does. No `attachments_trailer` (voice turns
// never have file attachments).
export const sendMessageRpc = command(
	'unchecked',
	async (input: { conversationId: string; content: string; model: string }) => {
		const stub = stubFor(input.conversationId);
		const result = await stub.addUserMessage(input.conversationId, input.content, input.model);
		if (result.status === 'busy') {
			error(409, 'Conversation busy: a generation is already in progress');
		}
		if (result.status === 'invalid') {
			error(400, `Invalid: ${result.reason}`);
		}
		return { ok: true as const };
	},
);

// Command: regenerate the conversation title (LLM round-trip on the DO).
// Triggered by the "↻" button next to the title. Returns once the title is
// persisted; the SSE stream's `refresh` event reloads the page client-side.
export const regenerateTitle = command('unchecked', async (conversationId: string) => {
	const stub = stubFor(conversationId);
	await stub.regenerateTitle(conversationId);
	return { ok: true as const };
});

// Command: set the per-conversation thinking-token budget. `null` disables
// extended thinking; positive integers cap it.
export const setThinkingBudget = command('unchecked', async (input: { conversationId: string; budget: number | null }) => {
	const stub = stubFor(input.conversationId);
	await stub.setThinkingBudget(input.conversationId, input.budget);
	return { ok: true as const };
});

// Command: override the global system prompt for this conversation only.
// `null` (or empty string) clears the override and falls back to the global
// setting / default.
export const setConversationSystemPrompt = command('unchecked', async (input: { conversationId: string; prompt: string | null }) => {
	const stub = stubFor(input.conversationId);
	await stub.setSystemPrompt(input.conversationId, input.prompt);
	return { ok: true as const };
});

// Command: pick a saved Style for this conversation. `null` clears the
// selection.
export const setConversationStyle = command('unchecked', async (input: { conversationId: string; styleId: number | null }) => {
	const stub = stubFor(input.conversationId);
	await stub.setStyle(input.conversationId, input.styleId);
	return { ok: true as const };
});

// Command: abort the current in-flight generation in this conversation.
// Persists whatever partial content exists as a complete message.
export const abortGeneration = command('unchecked', async (conversationId: string) => {
	const stub = stubFor(conversationId);
	await stub.abortGeneration(conversationId);
	return { ok: true as const };
});

// Command: manually compact the conversation context. Summarises older messages
// using an LLM call, removes them from the active history, and inserts a summary
// info message. Returns whether compaction actually occurred.
export const compactContext = command('unchecked', async (conversationId: string) => {
	const stub = stubFor(conversationId);
	const result = await stub.compactContext(conversationId);
	return result;
});

// Form: archive a conversation. Soft-delete only — the row stays in D1 and
// the DO storage is untouched, so unarchive restores everything.
export const archive = form('unchecked', async (data: { conversationId?: unknown; redirectTo?: unknown }) => {
	const id = String(data.conversationId ?? '');
	if (!CONVERSATION_ID_PATTERN.test(id)) error(400, `invalid conversation id: ${id}`);
	await archiveConversation(getEnv(), id);
	// Restrict to same-origin paths so a malicious form post can't turn this
	// into an open redirect. We require the path to start with `/` followed
	// only by URL-safe characters — this rejects protocol-relative
	// (`//host`, `/\host`), tab/CRLF smuggling, and percent-encoded slash
	// bypasses (`/%2F%2Fhost`).
	const raw = data.redirectTo;
	const candidate = typeof raw === 'string' ? raw.trim() : '/';
	const location =
		candidate.startsWith('/') &&
		!candidate.startsWith('//') &&
		!candidate.startsWith('/\\') &&
		/^\/[A-Za-z0-9_\-./?&=#%]*$/.test(candidate)
			? candidate
			: '/';
	redirect(303, location);
});

// Form: unarchive a conversation. Reverses `archive`.
export const unarchive = form('unchecked', async (data: { conversationId?: unknown }) => {
	const id = String(data.conversationId ?? '');
	if (!CONVERSATION_ID_PATTERN.test(id)) error(400, `invalid conversation id: ${id}`);
	await unarchiveConversation(getEnv(), id);
	redirect(303, `/c/${id}`);
});

// Form: hard-delete a conversation. Drops the D1 row AND wipes the Durable
// Object's SQLite storage. Cloudflare doesn't let us remove the DO id from
// the namespace, but `destroy()` empties it so the next resolution returns a
// blank instance. Caller is expected to confirm before invoking.
export const destroy = form('unchecked', async (data: { conversationId?: unknown }) => {
	const id = String(data.conversationId ?? '');
	if (!CONVERSATION_ID_PATTERN.test(id)) error(400, `invalid conversation id: ${id}`);
	const env = getEnv();
	// Wipe the DO first so a request that races the DB delete doesn't see
	// stale messages. If destroy() throws, the row stays — the operator can
	// retry.
	await getConversationStub(env, id).destroy();
	await deleteConversation(env, id);
	redirect(303, '/');
});
