// Scheme allowlist for URLs we put into `href=` / `src=` attributes.
//
// LLM tool output and user-pasted citations can contain arbitrary URLs,
// including `javascript:` / `vbscript:` / `data:text/html` schemes that
// execute when clicked. Components consume `safeExternalUrl(value)` and
// fall through to '#' for anything not in the allowlist.

const EXTERNAL_SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

export function safeExternalUrl(value: string | null | undefined): string {
	if (!value) return '#';
	const trimmed = value.trim();
	if (!trimmed) return '#';
	// Relative URLs and same-page anchors are safe.
	if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed;
	if (trimmed.startsWith('./') || trimmed.startsWith('../')) return trimmed;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		// Not parseable as an absolute URL — treat as plain text to avoid
		// surprising relative resolution against the page's base URL.
		return '#';
	}
	if (!EXTERNAL_SAFE_SCHEMES.includes(parsed.protocol)) return '#';
	return parsed.toString();
}

// `data:image/...` URIs are common for inline LLM-attached images; keep them
// when the consumer is an `<img src>` (not an `<a href>`). Other data:
// payloads are rejected.
export function safeImageUrl(value: string | null | undefined): string {
	if (!value) return '';
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (trimmed.toLowerCase().startsWith('data:image/')) return trimmed;
	return safeExternalUrl(value) === '#' ? '' : safeExternalUrl(value);
}
