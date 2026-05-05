import { describe, expect, it } from 'vitest';
import { MCP_SERVER_PRESETS, getMcpPreset } from './presets';

describe('MCP_SERVER_PRESETS', () => {
	it('every preset has id, label, url, transport, authMode, description', () => {
		for (const p of MCP_SERVER_PRESETS) {
			expect(p.id).toMatch(/^[a-z][a-z0-9_-]*$/);
			expect(p.label.length).toBeGreaterThan(0);
			expect(p.url).toMatch(/^https:\/\//);
			expect(['http', 'sse']).toContain(p.transport);
			expect(['oauth', 'bearer', 'none']).toContain(p.authMode);
			expect(p.description.length).toBeGreaterThan(0);
		}
	});

	it('ids are unique', () => {
		const ids = MCP_SERVER_PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('catalog includes the headline servers', () => {
		const ids = MCP_SERVER_PRESETS.map((p) => p.id);
		expect(ids).toEqual(expect.arrayContaining(['cloudflare', 'github', 'linear', 'sentry', 'context7']));
	});
});

describe('getMcpPreset', () => {
	it('returns the preset by id', () => {
		const p = getMcpPreset('cloudflare');
		expect(p).not.toBeNull();
		expect(p?.label).toBe('Cloudflare');
	});

	it('returns null for unknown ids', () => {
		expect(getMcpPreset('nope')).toBeNull();
		expect(getMcpPreset('')).toBeNull();
	});
});
