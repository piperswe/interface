import { command, form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { archiveConversation, createConversation, deleteConversation, unarchiveConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { conversationIdSchema, safeRedirectPath } from '$lib/server/remote-schemas';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

function stubFor(id: string) {
	return getConversationStub(getEnv(), id);
}

// Command: start a new conversation. Returns the new id so the caller can
// `goto(`/c/${id}`)` for an in-place SPA navigation. Bound to "New chat"
// buttons throughout the app. Accepts an optional client-pre-allocated id so
// the UI can navigate optimistically while the row is created in the
// background.
export const createNewConversation = command(
	z.object({ id: conversationIdSchema.optional() }).optional(),
	async (input) => {
		const env = getEnv();
		const id = await createConversation(env, input?.id);
		return { id };
	},
);

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
	z.object({
		conversationId: conversationIdSchema,
		content: z.string().default(''),
		model: z.string().default(''),
		attachments_trailer: z.string().optional().default(''),
	}),
	async ({ conversationId, content, model, attachments_trailer }) => {
		const fullContent = attachments_trailer ? content + attachments_trailer : content;
		const stub = stubFor(conversationId);
		const result = await stub.addUserMessage(conversationId, fullContent, model);
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
	z.object({
		conversationId: conversationIdSchema,
		content: z.string(),
		model: z.string(),
	}),
	async ({ conversationId, content, model }) => {
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

// Command: regenerate the conversation title (LLM round-trip on the DO).
// Triggered by the "↻" button next to the title. Returns once the title is
// persisted; the SSE stream's `refresh` event reloads the page client-side.
export const regenerateTitle = command(conversationIdSchema, async (conversationId) => {
	const stub = stubFor(conversationId);
	await stub.regenerateTitle(conversationId);
	return { ok: true as const };
});

// Command: set the per-conversation thinking-token budget. `null` disables
// extended thinking; positive integers cap it.
export const setThinkingBudget = command(
	z.object({
		conversationId: conversationIdSchema,
		budget: z.number().int().positive().nullable(),
	}),
	async ({ conversationId, budget }) => {
		const stub = stubFor(conversationId);
		await stub.setThinkingBudget(conversationId, budget);
		return { ok: true as const };
	},
);

// Command: override the global system prompt for this conversation only.
// `null` (or empty string) clears the override and falls back to the global
// setting / default.
export const setConversationSystemPrompt = command(
	z.object({
		conversationId: conversationIdSchema,
		prompt: z.string().nullable(),
	}),
	async ({ conversationId, prompt }) => {
		const stub = stubFor(conversationId);
		await stub.setSystemPrompt(conversationId, prompt);
		return { ok: true as const };
	},
);

// Command: pick a saved Style for this conversation. `null` clears the
// selection.
export const setConversationStyle = command(
	z.object({
		conversationId: conversationIdSchema,
		styleId: z.number().int().positive().nullable(),
	}),
	async ({ conversationId, styleId }) => {
		const stub = stubFor(conversationId);
		await stub.setStyle(conversationId, styleId);
		return { ok: true as const };
	},
);

// Command: abort the current in-flight generation in this conversation.
// Persists whatever partial content exists as a complete message.
export const abortGeneration = command(conversationIdSchema, async (conversationId) => {
	const stub = stubFor(conversationId);
	await stub.abortGeneration(conversationId);
	return { ok: true as const };
});

// Command: manually compact the conversation context. Summarises older messages
// using an LLM call, removes them from the active history, and inserts a summary
// info message. Returns whether compaction actually occurred.
export const compactContext = command(conversationIdSchema, async (conversationId) => {
	const stub = stubFor(conversationId);
	const result = await stub.compactContext(conversationId);
	return result;
});

// Form: archive a conversation. Soft-delete only — the row stays in D1 and
// the DO storage is untouched, so unarchive restores everything.
export const archive = form(
	z.object({
		conversationId: conversationIdSchema,
		redirectTo: safeRedirectPath('/'),
	}),
	async ({ conversationId, redirectTo }) => {
		await archiveConversation(getEnv(), conversationId);
		redirect(303, redirectTo);
	},
);

// Form: unarchive a conversation. Reverses `archive`.
export const unarchive = form(
	z.object({ conversationId: conversationIdSchema }),
	async ({ conversationId }) => {
		await unarchiveConversation(getEnv(), conversationId);
		redirect(303, `/c/${conversationId}`);
	},
);

// Form: hard-delete a conversation. Drops the D1 row AND wipes the Durable
// Object's SQLite storage. Cloudflare doesn't let us remove the DO id from
// the namespace, but `destroy()` empties it so the next resolution returns a
// blank instance. Caller is expected to confirm before invoking.
export const destroy = form(
	z.object({ conversationId: conversationIdSchema }),
	async ({ conversationId }) => {
		const env = getEnv();
		// Wipe the DO first so a request that races the DB delete doesn't see
		// stale messages. If destroy() throws, the row stays — the operator can
		// retry.
		await getConversationStub(env, conversationId).destroy();
		await deleteConversation(env, conversationId);
		redirect(303, '/');
	},
);
