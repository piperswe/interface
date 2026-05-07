// Shared helpers for vitest tests. Consolidates the `expectError` /
// `expectRedirect` / `runForm` / `AnyArgs` patterns that were previously
// copy-pasted into every `*.remote.test.ts` and route test file.
//
// Remote functions are typed as opaque `RemoteForm` / `RemoteCommand` /
// `RemoteQuery` by SvelteKit; under the test alias for `$app/server`
// (see `test/shims/app-server.ts`) they're plain callables, so tests cast
// through `unknown` to invoke them. `AnyArgs` is the lowest-common-
// denominator callable signature for that bridge.

import { isHttpError, isRedirect } from '@sveltejs/kit';
import { expect } from 'vitest';

/** Test-only signature for SvelteKit remote functions after the shim unwraps them. */
export type AnyArgs = (...args: unknown[]) => Promise<unknown>;

/**
 * Assert that `promise` rejects with a SvelteKit `redirect` whose location
 * starts with `locationStartsWith`. Anything else is rethrown so the test
 * fails with a useful stack.
 */
export async function expectRedirect(promise: Promise<unknown>, locationStartsWith: string): Promise<void> {
	try {
		await promise;
	} catch (e) {
		if (!isRedirect(e)) throw e;
		expect(e.location.startsWith(locationStartsWith)).toBe(true);
		return;
	}
	throw new Error(`expected redirect to ${locationStartsWith}, but promise resolved`);
}

/**
 * Assert that `promise` rejects with a SvelteKit `error()` of the given
 * status. When `msg` is supplied, also assert that the error body's
 * `.message` matches.
 */
export async function expectError(
	promise: Promise<unknown>,
	status: number,
	msg?: RegExp,
): Promise<void> {
	try {
		await promise;
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
		if (msg) expect(String(e.body.message)).toMatch(msg);
		return;
	}
	throw new Error(`expected HTTP error ${status}, but promise resolved`);
}

/**
 * Drive a `form()` handler that always finishes with `redirect(303, ...)`.
 * Swallows the redirect so the assertion-side of the test can inspect
 * the resulting D1 / DO state without dealing with the throw-as-control-
 * flow ergonomics of `redirect()`. Re-throws anything that isn't a
 * redirect.
 */
export async function runForm(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch (e) {
		if (!isRedirect(e)) throw e;
	}
}
