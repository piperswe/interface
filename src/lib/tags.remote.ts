import { command, form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import {
	addTagToConversation,
	createTag,
	deleteTag,
	removeTagFromConversation,
	renameTag,
} from '$lib/server/tags';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

export const addTag = form(
	'unchecked',
	async (data: { name?: unknown; color?: unknown; redirectTo?: unknown }) => {
		const name = String(data.name ?? '').trim();
		if (!name) error(400, 'Tag name is required');
		const colorRaw = String(data.color ?? '').trim();
		try {
			await createTag(getEnv(), { name, color: colorRaw || null });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		const target = String(data.redirectTo ?? '/settings');
		redirect(303, target);
	},
);

export const renameTagForm = form(
	'unchecked',
	async (data: { id?: unknown; name?: unknown; color?: unknown }) => {
		const id = Number.parseInt(String(data.id ?? ''), 10);
		if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
		const name = String(data.name ?? '').trim();
		const color = String(data.color ?? '').trim();
		try {
			await renameTag(getEnv(), id, { name: name || undefined, color: color || null });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const removeTag = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	await deleteTag(getEnv(), id);
	redirect(303, '/settings');
});

// Quick-tag command from the conversation header. Idempotent.
export const tagConversation = command(
	'unchecked',
	async (input: { conversationId: string; tagId: number; attached: boolean }) => {
		if (!CONVERSATION_ID_PATTERN.test(input.conversationId)) error(400, 'invalid conversation id');
		const tagId = Number(input.tagId);
		if (!Number.isFinite(tagId) || tagId <= 0) error(400, 'invalid tag id');
		const env = getEnv();
		if (input.attached) await addTagToConversation(env, input.conversationId, tagId);
		else await removeTagFromConversation(env, input.conversationId, tagId);
		return { ok: true as const };
	},
);

// Quick-tag command that creates a tag (if it doesn't exist) and attaches
// it to the conversation in a single round-trip. Falls back to a lookup
// when the unique-name constraint fires.
export const createAndTagConversation = command(
	'unchecked',
	async (input: { conversationId: string; name: string; color?: string | null }) => {
		if (!CONVERSATION_ID_PATTERN.test(input.conversationId)) error(400, 'invalid conversation id');
		const name = String(input.name ?? '').trim();
		if (!name) error(400, 'Tag name is required');
		const env = getEnv();
		let tagId: number;
		try {
			tagId = await createTag(env, { name, color: input.color ?? null });
		} catch {
			// Race or duplicate: look up the existing tag id.
			const row = await env.DB.prepare('SELECT id FROM tags WHERE user_id = 1 AND name = ?')
				.bind(name)
				.first<{ id: number }>();
			if (!row) error(500, 'failed to create or look up tag');
			tagId = row.id;
		}
		await addTagToConversation(env, input.conversationId, tagId);
		return { id: tagId };
	},
);
