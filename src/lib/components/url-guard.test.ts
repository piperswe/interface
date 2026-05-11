import { describe, expect, it } from 'vitest';
import { safeExternalUrl, safeImageUrl } from './url-guard';

describe('safeExternalUrl', () => {
	// Regression: citation/tool URLs used to flow into `href={c.url}` with no
	// scheme allowlist. LLM-supplied `javascript:alert(1)` would execute on
	// click. The guard now collapses anything outside the allowlist to '#'.
	it('rejects javascript: URLs', () => {
		expect(safeExternalUrl('javascript:alert(1)')).toBe('#');
		expect(safeExternalUrl('JavaScript:alert(1)')).toBe('#');
		expect(safeExternalUrl('  javascript:alert(1)  ')).toBe('#');
	});

	it('rejects vbscript: URLs', () => {
		expect(safeExternalUrl('vbscript:msgbox(1)')).toBe('#');
	});

	it('rejects data: URLs (which can be text/html)', () => {
		expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
		expect(safeExternalUrl('data:image/png;base64,AAA')).toBe('#');
	});

	it('rejects unknown / file schemes', () => {
		expect(safeExternalUrl('file:///etc/passwd')).toBe('#');
		expect(safeExternalUrl('ftp://example.com')).toBe('#');
	});

	it('accepts http and https URLs', () => {
		expect(safeExternalUrl('http://example.com/')).toBe('http://example.com/');
		expect(safeExternalUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
	});

	it('accepts mailto and tel', () => {
		expect(safeExternalUrl('mailto:foo@example.com')).toBe('mailto:foo@example.com');
		expect(safeExternalUrl('tel:+1-555-0100')).toBe('tel:+1-555-0100');
	});

	it('passes through same-page anchors and relative URLs unchanged', () => {
		expect(safeExternalUrl('#section')).toBe('#section');
		expect(safeExternalUrl('/about')).toBe('/about');
		expect(safeExternalUrl('./nested')).toBe('./nested');
		expect(safeExternalUrl('../up')).toBe('../up');
	});

	it('returns # for empty / nullish input', () => {
		expect(safeExternalUrl('')).toBe('#');
		expect(safeExternalUrl(null)).toBe('#');
		expect(safeExternalUrl(undefined)).toBe('#');
	});
});

describe('safeImageUrl', () => {
	// `data:image/...` is allowed for inline LLM-attached images, but other
	// data: payloads (text/html, application/javascript) are blocked.
	it('allows data:image/* URIs', () => {
		expect(safeImageUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
		expect(safeImageUrl('data:image/svg+xml;base64,AAA')).toBe('data:image/svg+xml;base64,AAA');
	});

	it('blocks data:text/html', () => {
		expect(safeImageUrl('data:text/html,<script>alert(1)</script>')).toBe('');
	});

	it('blocks javascript:', () => {
		expect(safeImageUrl('javascript:alert(1)')).toBe('');
	});

	it('allows http(s) image URLs', () => {
		expect(safeImageUrl('https://example.com/x.png')).toBe('https://example.com/x.png');
	});
});
