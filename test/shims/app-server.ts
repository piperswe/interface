// `$app/server` is provided by SvelteKit at runtime — vitest needs a stub so
// modules importing remote-function helpers can be evaluated in unit tests
// without a full SvelteKit environment. Tests that exercise remote functions
// directly are not run here; the helpers go through the SvelteKit dev server.
export const query = (..._args: unknown[]): never => {
	throw new Error('query() is unavailable in this test environment');
};
export const command = (..._args: unknown[]): never => {
	throw new Error('command() is unavailable in this test environment');
};
export const form = (..._args: unknown[]): never => {
	throw new Error('form() is unavailable in this test environment');
};
export const prerender = (..._args: unknown[]): never => {
	throw new Error('prerender() is unavailable in this test environment');
};
export const getRequestEvent = (): never => {
	throw new Error('getRequestEvent() is unavailable in this test environment');
};
