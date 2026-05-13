// Helpers for runtime-validating foreign data with zod.
//
// We treat anything that comes from outside the running TypeScript code —
// LLM tool calls, HTTP responses from third-party APIs, MCP wire messages,
// JSON payloads stored in DB columns, form bodies — as untyped and run it
// through a zod schema before treating it as a known shape.

import { type ZodError, type ZodSchema, type ZodTypeAny, z } from 'zod';

// Generic safe-parse-or-error helper. Returns either `{ ok: true, value }`
// or `{ ok: false, error }`, where `error` is a short summary of the first
// few zod issues — suitable for surfacing to a model or log line.
export function safeValidate<S extends ZodTypeAny>(
	schema: S,
	data: unknown,
): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
	const parsed = schema.safeParse(data);
	if (parsed.success) return { ok: true, value: parsed.data };
	return { error: formatZodError(parsed.error), ok: false };
}

// Throw on validation failure. Use when the caller would otherwise have
// blindly cast the value with `as Type` — failures should be exceptional
// and bubbling them up makes the bug visible.
export function validateOrThrow<S extends ZodTypeAny>(schema: S, data: unknown, context: string): z.infer<S> {
	const parsed = schema.safeParse(data);
	if (parsed.success) return parsed.data;
	throw new ValidationError(context, parsed.error);
}

export class ValidationError extends Error {
	readonly issues: ZodError;
	constructor(context: string, issues: ZodError) {
		super(`${context}: ${formatZodError(issues)}`);
		this.name = 'ValidationError';
		this.issues = issues;
	}
}

// Format a zod error as a short human-readable string. Uses the first three
// issues so we don't dump a giant blob into a tool result or log line.
export function formatZodError(error: ZodError): string {
	const issues = error.issues.slice(0, 3).map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
		return `${path}: ${issue.message}`;
	});
	const more = error.issues.length > 3 ? ` (+${error.issues.length - 3} more)` : '';
	return issues.join('; ') + more;
}

// Parse a JSON string and validate it in one step. Returns null on either
// JSON syntax errors or schema mismatches; pass a logger if you need to
// distinguish the two.
export function parseJsonWith<S extends ZodTypeAny>(schema: S, json: string): z.infer<S> | null {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return null;
	}
	const parsed = schema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

export type { ZodSchema, ZodTypeAny };
export { z };
