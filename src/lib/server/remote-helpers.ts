// Shared helpers for SvelteKit remote functions (`*.remote.ts`). Every
// remote file pulls `platform.env`, parses `unknown` form values, and
// validates positive-int ids the same way; centralising those patterns
// keeps the error messages and validation rules consistent.

import { getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';

/**
 * Pull the Cloudflare bindings out of the current request event. Throws a
 * 500 when the platform proxy isn't attached (vite dev without the
 * adapter, misconfigured tests, etc.).
 */
export function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

/**
 * Coerce a form-data field to a string. SvelteKit's remote-form input is
 * typed as `unknown` because the wire format only guarantees JSON; this
 * helper applies the canonical `String(x ?? '')` normalisation so empty
 * fields collapse to `''` instead of `'undefined'` / `'null'`.
 */
export function formString(value: unknown): string {
	return String(value ?? '');
}

/** Same as `formString` but trims surrounding whitespace. */
export function formTrim(value: unknown): string {
	return String(value ?? '').trim();
}

/**
 * Parse a form field as a positive integer id (`> 0`). Throws a 400 with
 * the supplied label when the value is missing, non-numeric, or
 * non-positive. Used for D1 row ids returned to the client as numbers.
 */
export function parseFormId(value: unknown, label = 'id'): number {
	const n = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(n) || n <= 0) error(400, `Invalid ${label}`);
	return n;
}

/**
 * Restrict a `redirectTo` form field to same-origin paths so a malicious
 * caller can't turn a redirect form into an open-redirect. Protocol-
 * relative URLs (`//host`, `/\host`) are rejected and replaced with
 * `fallback`.
 */
export function safeRedirectTo(raw: unknown, fallback: string): string {
	const s = String(raw ?? fallback);
	return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : fallback;
}
