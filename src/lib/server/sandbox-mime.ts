// Centralized extension → MIME map for files served from the sandbox R2
// bucket. Both the file-download endpoint and the upload endpoint reach for
// this list when no client-provided content type is available.

import db from 'mime-db';

const SANDBOX_MIME_BY_EXT: Record<string, string> = Object.fromEntries(
	Object.entries(db).flatMap(([typ, { extensions }]) => extensions?.map((ext) => [ext, typ]) ?? []),
);

export const DEFAULT_BINARY_MIME = 'application/octet-stream';

// Look up a content type by file path or bare extension. Returns
// `application/octet-stream` for unknown extensions so callers can use the
// result directly as a `Content-Type` header.
export function mimeTypeForPath(pathOrExt: string): string {
	const ext = pathOrExt.includes('.') ? (pathOrExt.split('.').pop() ?? '') : pathOrExt;
	return SANDBOX_MIME_BY_EXT[ext.toLowerCase()] ?? DEFAULT_BINARY_MIME;
}
