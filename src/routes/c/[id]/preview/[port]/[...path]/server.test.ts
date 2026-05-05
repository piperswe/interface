import { describe, expect, it } from 'vitest';
import { _buildPreviewUrl } from './+server';

const CONV_ID = '12345678-1234-1234-1234-123456789abc';

describe('_buildPreviewUrl', () => {
	// Regression: `new URL(path, base)` only carries forward what's in the
	// path argument; if we pass just the pathname the original query string
	// is lost. Sandboxed apps that read URL params (?id=42, ?token=...)
	// would break silently. The fix appends `url.search` to the path.
	it('preserves the query string from the incoming request', () => {
		const out = _buildPreviewUrl({
			port: 3000,
			conversationId: CONV_ID,
			hostname: 'interface.example',
			path: 'api/items',
			search: '?id=42&filter=active',
		});
		expect(out.search).toBe('?id=42&filter=active');
		expect(out.searchParams.get('id')).toBe('42');
		expect(out.searchParams.get('filter')).toBe('active');
	});

	it('routes to the Sandbox preview hostname pattern', () => {
		const out = _buildPreviewUrl({
			port: 8080,
			conversationId: CONV_ID,
			hostname: 'app.example',
			path: '',
			search: '',
		});
		expect(out.host).toBe(`8080-${CONV_ID}-preview.app.example`);
		expect(out.pathname).toBe('/');
	});

	it('handles a missing path with no query string', () => {
		const out = _buildPreviewUrl({
			port: 3000,
			conversationId: CONV_ID,
			hostname: 'app.example',
			path: undefined,
			search: '',
		});
		expect(out.pathname).toBe('/');
		expect(out.search).toBe('');
	});

	it('preserves nested paths joined by SvelteKit catch-all params', () => {
		const out = _buildPreviewUrl({
			port: 3000,
			conversationId: CONV_ID,
			hostname: 'app.example',
			path: 'docs/intro/index.html',
			search: '?ref=home',
		});
		expect(out.pathname).toBe('/docs/intro/index.html');
		expect(out.search).toBe('?ref=home');
	});
});
