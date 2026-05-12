// `$app/server` shim used by vitest. SvelteKit's runtime helpers wrap a
// user function in a transport-aware adapter; for unit tests we strip the
// wrapper so the user function is callable directly. Tests inject a mock
// request event via `setMockRequestEvent` so handlers can pull
// `platform.env`.
//
// When a Standard Schema (Zod) is passed as the first argument to
// `form`/`command`/`query`, we run validation against the input here and
// throw a 400 HttpError on failure. That mirrors what SvelteKit does for
// commands in production, and lets the existing unit-test pattern
// (`expectError(call, 400)`) keep working without each test having to
// inspect form `issues` directly.

import { error } from '@sveltejs/kit';

type AnyFn = (...args: unknown[]) => unknown;
type StandardSchema = {
	'~standard': {
		validate: (value: unknown) => { value?: unknown; issues?: readonly { message: string; path?: ReadonlyArray<{ key: string | number } | string | number> }[] } | Promise<{ value?: unknown; issues?: readonly { message: string; path?: ReadonlyArray<{ key: string | number } | string | number> }[] }>;
	};
};

function isStandardSchema(v: unknown): v is StandardSchema {
	return typeof v === 'object' && v !== null && '~standard' in v;
}

function formatIssues(
	issues: readonly { message: string; path?: ReadonlyArray<{ key: string | number } | string | number> }[],
): string {
	return issues
		.slice(0, 3)
		.map((issue) => {
			const path = (issue.path ?? [])
				.map((p) => (typeof p === 'object' && p !== null ? p.key : p))
				.join('.');
			return path ? `${path}: ${issue.message}` : issue.message;
		})
		.join('; ');
}

function applySchema(schema: StandardSchema, fn: AnyFn): AnyFn {
	return async (...args: unknown[]) => {
		const result = await schema['~standard'].validate(args[0]);
		if (result.issues) {
			error(400, formatIssues(result.issues));
		}
		return fn(result.value, ...args.slice(1));
	};
}

function unwrap(args: unknown[]): AnyFn {
	// `form(fn)` / `command(fn)` / `query(fn)` — single-argument form.
	if (args.length === 1 && typeof args[0] === 'function') {
		return args[0] as AnyFn;
	}
	// `form(validate, fn)` / `command(validate, fn)` / `query(schema, fn)`.
	const validator = args[0];
	const fn = args[1] as AnyFn;
	if (validator === 'unchecked') return fn;
	if (isStandardSchema(validator)) return applySchema(validator, fn);
	return fn;
}

// Form helpers attach `.for(key)` for per-key instances. Tests rarely care,
// so we return a callable function that also exposes `.for()` returning the
// same handler.
function attachFormHelpers(fn: AnyFn): AnyFn & { for: (key: unknown) => AnyFn } {
	const wrapped = ((...args: unknown[]) => fn(...args)) as AnyFn & { for: (key: unknown) => AnyFn };
	wrapped.for = () => wrapped;
	return wrapped;
}

export const form = (...args: unknown[]) => attachFormHelpers(unwrap(args));
export const command = (...args: unknown[]) => unwrap(args);
export const query = (...args: unknown[]) => unwrap(args);
export const prerender = (...args: unknown[]) => unwrap(args);

let mockRequestEvent: unknown = null;

export function setMockRequestEvent(event: unknown): void {
	mockRequestEvent = event;
}

export function clearMockRequestEvent(): void {
	mockRequestEvent = null;
}

export function getRequestEvent(): unknown {
	if (mockRequestEvent === null) {
		throw new Error('getRequestEvent() called without setMockRequestEvent() in tests');
	}
	return mockRequestEvent;
}
