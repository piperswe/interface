// Trim an arbitrary error value to a single human-readable string capped at
// 500 chars, suitable for an `error` SSE event or a persisted `messages.error`
// column. Used by both LLM adapters and the DO's generation path.
export function formatError(e: unknown): string {
	if (e instanceof Error && e.message) return e.message.slice(0, 500);
	if (typeof e === 'object' && e !== null) {
		try {
			return JSON.stringify(e).slice(0, 500);
		} catch {
			/* fall through */
		}
	}
	return String(e).slice(0, 500);
}
