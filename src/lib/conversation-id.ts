// Shared conversation-id pattern. Matches lowercase UUIDs in the canonical
// 8-4-4-4-12 hex layout produced by `crypto.randomUUID()`. Lives outside
// `lib/server/` because route validators on the client side share it (e.g.
// `+page.server.ts` route guards). Server-only, but cheap to ship.
//
// The pattern enforces the dash positions so pathological strings of pure
// dashes ("------------------------------------") or 36 zeros are rejected
// at the route boundary instead of flowing into D1 / Durable Object lookups.
export const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
