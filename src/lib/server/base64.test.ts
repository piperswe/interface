import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from './base64';

describe('bytesToBase64', () => {
	it('encodes an empty array to an empty string', () => {
		expect(bytesToBase64(new Uint8Array())).toBe('');
	});

	it('matches btoa for small ASCII payloads', () => {
		const bytes = new TextEncoder().encode('hello world');
		expect(bytesToBase64(bytes)).toBe(btoa('hello world'));
	});

	it('round-trips arbitrary binary bytes', () => {
		const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
		const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
		expect([...decoded]).toEqual([...bytes]);
	});

	it('does not overflow the call stack on payloads larger than one chunk', () => {
		// Regression: spreading a large Uint8Array into String.fromCharCode
		// throws "Maximum call stack size exceeded" — encoding must chunk.
		const bytes = new Uint8Array(0x8000 * 3 + 17).map((_, i) => i % 256);
		const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
		expect(decoded.length).toBe(bytes.length);
		expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
	});
});
