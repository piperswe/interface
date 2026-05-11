import { describe, expect, it } from 'vitest';
import {
	_buildPreviewUrl,
	_parsePreviewPort,
	_buildSanitizedProxyRequest,
} from './+server';

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

describe('_parsePreviewPort', () => {
	// Regression: parseInt('3000abc', 10) === 3000, so the original guard let
	// trailing junk through. We now require digits-only and a port in [1, 65535].
	it('accepts plain digit strings in [1, 65535]', () => {
		expect(_parsePreviewPort('1')).toBe(1);
		expect(_parsePreviewPort('80')).toBe(80);
		expect(_parsePreviewPort('3000')).toBe(3000);
		expect(_parsePreviewPort('65535')).toBe(65535);
	});

	it('rejects trailing or leading junk', () => {
		expect(_parsePreviewPort('3000abc')).toBeNull();
		expect(_parsePreviewPort('abc3000')).toBeNull();
		expect(_parsePreviewPort('30 00')).toBeNull();
		expect(_parsePreviewPort('30.00')).toBeNull();
		expect(_parsePreviewPort('30\n00')).toBeNull();
	});

	it('rejects zero, negative, hex, and out-of-range ports', () => {
		expect(_parsePreviewPort('0')).toBeNull();
		expect(_parsePreviewPort('-1')).toBeNull();
		expect(_parsePreviewPort('0x80')).toBeNull();
		expect(_parsePreviewPort('65536')).toBeNull();
		expect(_parsePreviewPort('999999')).toBeNull();
		expect(_parsePreviewPort('')).toBeNull();
	});
});

describe('_buildSanitizedProxyRequest', () => {
	// Regression: the original `new Request(previewUrl, request)` copied browser
	// cookies, Authorization headers, and CF-Connecting-IP into the container —
	// handing LLM-supplied code the operator's session cookies and real IP.
	it('strips Cookie and Authorization headers', () => {
		const target = new URL('http://3000-id-preview.example/');
		const inbound = new Request('http://app.example/c/x/preview/3000/', {
			method: 'GET',
			headers: {
				Cookie: 'session=secret',
				Authorization: 'Bearer leak',
				'User-Agent': 'browser/1',
			},
		});
		const out = _buildSanitizedProxyRequest(target, inbound);
		expect(out.headers.get('Cookie')).toBeNull();
		expect(out.headers.get('Authorization')).toBeNull();
		expect(out.headers.get('User-Agent')).toBe('browser/1');
	});

	it('strips X-Forwarded-* and CF-* fingerprinting headers', () => {
		const target = new URL('http://3000-id-preview.example/');
		const inbound = new Request('http://app.example/c/x/preview/3000/', {
			method: 'GET',
			headers: {
				'X-Forwarded-For': '1.2.3.4',
				'X-Forwarded-Proto': 'https',
				'CF-Connecting-IP': '1.2.3.4',
				'CF-Ray': 'abc-IAD',
				'X-Real-IP': '1.2.3.4',
				Forwarded: 'for=1.2.3.4',
				'Accept-Language': 'en',
			},
		});
		const out = _buildSanitizedProxyRequest(target, inbound);
		expect(out.headers.get('X-Forwarded-For')).toBeNull();
		expect(out.headers.get('X-Forwarded-Proto')).toBeNull();
		expect(out.headers.get('CF-Connecting-IP')).toBeNull();
		expect(out.headers.get('CF-Ray')).toBeNull();
		expect(out.headers.get('X-Real-IP')).toBeNull();
		expect(out.headers.get('Forwarded')).toBeNull();
		// Non-sensitive headers survive.
		expect(out.headers.get('Accept-Language')).toBe('en');
	});

	it('preserves the request method and target URL', () => {
		const target = new URL('http://3000-id-preview.example/path?q=1');
		const inbound = new Request('http://app.example/c/x/preview/3000/', {
			method: 'GET',
			headers: { 'X-Forwarded-For': '1.2.3.4' },
		});
		const out = _buildSanitizedProxyRequest(target, inbound);
		expect(out.method).toBe('GET');
		expect(out.url).toBe('http://3000-id-preview.example/path?q=1');
	});
});
