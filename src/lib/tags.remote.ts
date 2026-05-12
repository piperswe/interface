import { command, form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import {
	addTagToConversation,
	createTag,
	deleteTag,
	removeTagFromConversation,
	renameTag,
} from '$lib/server/tags';
import {
	conversationIdSchema,
	positiveIntFlexible,
	positiveIntFromString,
	safeRedirectPath,
	trimmedNonEmpty,
	trimmedOptionalOrNull,
} from '$lib/server/remote-schemas';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

export const addTag = form(
	z.object({
		name: trimmedNonEmpty('Tag name is required'),
		color: trimmedOptionalOrNull,
		redirectTo: safeRedirectPath('/settings'),
	}),
	async ({ name, color, redirectTo }) => {
		try {
			await createTag(getEnv(), { name, color });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, redirectTo);
	},
);

export const renameTagForm = form(
	z.object({
		id: positiveIntFromString,
		name: trimmedOptionalOrNull,
		color: trimmedOptionalOrNull,
	}),
	async ({ id, name, color }) => {
		try {
			await renameTag(getEnv(), id, { name: name ?? undefined, color });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const removeTag = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
		await deleteTag(getEnv(), id);
		redirect(303, '/settings');
	},
);

// Quick-tag command from the conversation header. Idempotent.
export const tagConversation = command(
	z.object({
		conversationId: conversationIdSchema,
		tagId: positiveIntFlexible,
		attached: z.boolean(),
	}),
	async ({ conversationId, tagId, attached }) => {
		const env = getEnv();
		if (attached) await addTagToConversation(env, conversationId, tagId);
		else await removeTagFromConversation(env, conversationId, tagId);
		return { ok: true as const };
	},
);

// Quick-tag command that creates a tag (if it doesn't exist) and attaches
// it to the conversation in a single round-trip. Falls back to a lookup
// when the unique-name constraint fires.
export const createAndTagConversation = command(
	z.object({
		conversationId: conversationIdSchema,
		name: trimmedNonEmpty('Tag name is required'),
		color: z.string().nullable().optional(),
	}),
	async ({ conversationId, name, color }) => {
		const env = getEnv();
		let tagId: number;
		try {
			tagId = await createTag(env, { name, color: color ?? null });
		} catch {
			// Race or duplicate: look up the existing tag id.
			const row = await env.DB.prepare('SELECT id FROM tags WHERE user_id = 1 AND name = ?')
				.bind(name)
				.first<{ id: number }>();
			if (!row) error(500, 'failed to create or look up tag');
			tagId = row.id;
		}
		await addTagToConversation(env, conversationId, tagId);
		return { id: tagId };
	},
);
