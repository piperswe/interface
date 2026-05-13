// Trim an arbitrary error value to a single human-readable string capped at
// 500 chars, suitable for an `error` SSE event or a persisted `messages.error`
// column. Used by both LLM adapters and the DO's generation path.
//
// Providers occasionally echo the request `Authorization` header (or the raw
// API key) back into error response bodies. Without redaction, those keys
// land verbatim in the SSE error event and the `messages.error` column.
// `redactSecrets` runs over the message before truncation.

const REDACTED = '***REDACTED***';

// Anthropic-style: `sk-ant-…`, OpenAI: `sk-…`, OpenRouter: `sk-or-…`,
// generic 32+ char alphanumeric tokens after `Authorization: Bearer ` /
// `api-key:` / `x-api-key:` / `api_key=`.
const REDACT_PATTERNS: RegExp[] = [
	/sk-ant-[A-Za-z0-9_-]{20,}/g,
	/sk-or-[A-Za-z0-9_-]{20,}/g,
	/sk-proj-[A-Za-z0-9_-]{20,}/g,
	/\bsk-[A-Za-z0-9_-]{20,}/g,
	// `Bearer <token>` anywhere — covers standalone Authorization-header
	// strings echoed by providers.
	/(\bbearer\s+)[A-Za-z0-9._-]{12,}/gi,
	// Authorization: Bearer <token> (catches the prefix too, so the redacted
	// output reads `authorization: Bearer ***REDACTED***`).
	/(authorization\s*[:=]\s*['"]?bearer\s+)[A-Za-z0-9._-]{12,}/gi,
	// api[-_]?key: <token> / x-api-key: <token>
	/((?:x-)?api[-_]?key\s*[:=]\s*['"]?)[A-Za-z0-9._-]{12,}/gi,
	// JSON-shaped: "authorization": "Bearer ..." / "api_key": "..."
	/("?(?:authorization|api[-_]?key)"?\s*:\s*"bearer\s+)[A-Za-z0-9._-]{12,}/gi,
	/("?(?:authorization|api[-_]?key|api[-_]?token|access[-_]?token)"?\s*:\s*")[A-Za-z0-9._-]{12,}/gi,
];

export function redactSecrets(s: string): string {
	let out = s;
	for (const re of REDACT_PATTERNS) {
		// `replace` calls back with `(match, ...args)` where the trailing args
		// vary by regex shape: with a capture group it's `(match, p1, offset,
		// string)`; without one it's `(match, offset, string)`. The first
		// extra arg is therefore a string only when the regex actually has a
		// capture group — typeof-checking before concatenating prevents the
		// offset number from being stringified into the output (e.g. an
		// echoed `sk-ant-…` at index 9 was producing `"9***REDACTED***"`).
		out = out.replace(re, (_match: string, ...args: unknown[]) => {
			const prefix = typeof args[0] === 'string' ? args[0] : undefined;
			return prefix ? prefix + REDACTED : REDACTED;
		});
	}
	return out;
}

export function formatError(e: unknown): string {
	let raw: string;
	if (e instanceof Error && e.message) {
		raw = e.message;
	} else if (typeof e === 'object' && e !== null) {
		try {
			raw = JSON.stringify(e);
		} catch {
			raw = String(e);
		}
	} else {
		raw = String(e);
	}
	return redactSecrets(raw).slice(0, 500);
}
