// Centralized extension → MIME map for files served from the sandbox R2
// bucket. Both the file-download endpoint and the upload endpoint reach for
// this list when no client-provided content type is available.

const SANDBOX_MIME_BY_EXT: Record<string, string> = {
	txt: 'text/plain',
	md: 'text/markdown',
	js: 'application/javascript',
	jsx: 'application/javascript',
	ts: 'application/typescript',
	tsx: 'application/typescript',
	json: 'application/json',
	html: 'text/html',
	css: 'text/css',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	pdf: 'application/pdf',
	csv: 'text/csv',
	xml: 'application/xml',
	yaml: 'application/yaml',
	yml: 'application/yaml',
	py: 'text/x-python',
	sh: 'application/x-sh',
	toml: 'application/toml',
};

export const DEFAULT_BINARY_MIME = 'application/octet-stream';

// Look up a content type by file path or bare extension. Returns
// `application/octet-stream` for unknown extensions so callers can use the
// result directly as a `Content-Type` header.
export function mimeTypeForPath(pathOrExt: string): string {
	const ext = pathOrExt.includes('.') ? (pathOrExt.split('.').pop() ?? '') : pathOrExt;
	return SANDBOX_MIME_BY_EXT[ext.toLowerCase()] ?? DEFAULT_BINARY_MIME;
}
