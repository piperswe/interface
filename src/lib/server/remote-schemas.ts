// Reusable Zod primitives for SvelteKit remote-function validators
// (`query` / `command` / `form`). Schemas live inline in each
// `*.remote.ts` file; only patterns shared across multiple files belong
// here. See AGENTS.md for the remote-function conventions.

import { z } from 'zod';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';

export const conversationIdSchema = z.string().regex(CONVERSATION_ID_PATTERN, 'invalid conversation id');

// Form id field. FormData sends it as a string; JS callers sometimes pass a
// number directly (via `form.for(numericId)` etc.). Accept both at the input
// boundary so `RemoteForm.for()` accepts the natural DB type.
export const positiveIntFromString = z.union([z.string(), z.number()]).pipe(z.coerce.number().int().positive('Invalid id'));

// RPC numeric id. JSON-encoded callers send a number; FormData callers
// send a string. `z.coerce.number()` accepts both.
export const positiveIntFlexible = z.coerce.number().int().positive();

// Same-origin redirect path. Rejects protocol-relative URLs (`//host`,
// `/\host`), CRLF smuggling, and percent-encoded slash bypasses. Returns
// `fallback` for any input that isn't a benign same-origin path. The input
// type is `string | undefined` so the surrounding `RemoteFormInput` shape
// stays valid.
export const safeRedirectPath = (fallback = '/settings') =>
	z
		.string()
		.optional()
		.transform((v) => {
			const t = (v ?? '').trim();
			if (!t.startsWith('/')) return fallback;
			if (t.startsWith('//') || t.startsWith('/\\')) return fallback;
			if (!/^\/[A-Za-z0-9_\-./?&=#%]*$/.test(t)) return fallback;
			return t;
		});

// HTML checkbox: 'on' | 'true' | '1' when checked; missing/empty otherwise.
export const checkboxBoolean = z
	.string()
	.optional()
	.transform((v) => {
		if (v == null || v === '') return false;
		const s = v.toLowerCase();
		return s === 'on' || s === 'true' || s === '1';
	});

export const trimmedNonEmpty = (msg = 'Required') => z.string().trim().min(1, msg);

// Optional trimmed string; empty / whitespace-only becomes null.
export const trimmedOptionalOrNull = z
	.string()
	.optional()
	.transform((v) => {
		const t = (v ?? '').trim();
		return t === '' ? null : t;
	});
