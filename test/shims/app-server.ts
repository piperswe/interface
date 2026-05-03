// `$app/server` shim used by vitest. SvelteKit's runtime helpers wrap a
// user function in a transport-aware adapter; for unit tests we strip the
// wrapper so the user function is callable directly. Tests inject a mock
// request event via `setMockRequestEvent` so handlers can pull
// `platform.env`.

type AnyFn = (...args: unknown[]) => unknown;

function unwrap(args: unknown[]): AnyFn {
	// `form(fn)` / `command(fn)` / `query(fn)` — single-argument form.
	if (args.length === 1 && typeof args[0] === 'function') {
		return args[0] as AnyFn;
	}
	// `form(validate, fn)` / `command(validate, fn)` / `query(schema, fn)`.
	return args[1] as AnyFn;
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
