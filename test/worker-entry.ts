// Stub Worker entry used only by `vitest-pool-workers` so it has a real
// script to bundle. The integration tests interact with the Durable Object
// directly via `getByName(...)`; the SvelteKit handler doesn't need to run.
export { default as ConversationDurableObject } from '$lib/server/durable_objects/ConversationDurableObject';

export default {
	async fetch(): Promise<Response> {
		return new Response('not-found', { status: 404 });
	},
};
