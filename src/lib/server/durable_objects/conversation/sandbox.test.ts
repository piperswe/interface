import { describe, expect, it } from 'vitest';
import { _listExposedPorts } from './sandbox';

describe('_listExposedPorts', () => {
	// Regression: getExposedPorts requires a hostname argument — the SDK uses
	// it to construct preview URLs. The old code called it with no arguments
	// (undefined), causing the call to fail silently and always return [].
	it('passes the hostname to getExposedPorts', async () => {
		let capturedHostname: string | undefined;
		const fakeSandbox = {
			getExposedPorts: async (hostname: string) => {
				capturedHostname = hostname;
				return [];
			},
		};
		await _listExposedPorts(fakeSandbox, 'interface.example.com');
		expect(capturedHostname).toBe('interface.example.com');
	});

	it('returns mapped port entries from an array response', async () => {
		const fakeSandbox = {
			getExposedPorts: async (_hostname: string) => [
				{ port: 8000, status: 'active' as const, url: 'https://8000-id-preview.example.com' },
				{ name: 'dev', port: 3000, status: 'active' as const, url: 'https://3000-id-preview.example.com' },
			],
		};
		const result = await _listExposedPorts(fakeSandbox, 'example.com');
		expect(result).toEqual([
			{ name: undefined, port: 8000, url: 'https://8000-id-preview.example.com' },
			{ name: 'dev', port: 3000, url: 'https://3000-id-preview.example.com' },
		]);
	});

	it('normalises an object-shaped response with a ports property', async () => {
		const fakeSandbox = {
			getExposedPorts: async (_hostname: string) =>
				// Some SDK versions returned { ports: [...] } instead of a plain array.
				({ ports: [{ port: 8080, url: 'https://8080-id-preview.example.com' }] }),
		};
		const result = await _listExposedPorts(fakeSandbox, 'example.com');
		expect(result).toHaveLength(1);
		expect(result[0].port).toBe(8080);
	});

	it('returns an empty array when there are no exposed ports', async () => {
		const fakeSandbox = {
			getExposedPorts: async (_hostname: string) => [],
		};
		const result = await _listExposedPorts(fakeSandbox, 'example.com');
		expect(result).toEqual([]);
	});
});
