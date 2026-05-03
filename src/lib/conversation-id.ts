// Shared conversation-id pattern (UUIDv4-ish lowercase hex). Lives outside
// `lib/server/` because route validators on the client side share it (e.g.
// `+page.server.ts` route guards). Server-only, but cheap to ship.
export const CONVERSATION_ID_PATTERN = /^[0-9a-f-]{36}$/;
