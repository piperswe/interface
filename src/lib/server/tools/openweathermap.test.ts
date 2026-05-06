import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenWeatherMapTools } from './openweathermap';

const ctx = { env, conversationId: 'c', assistantMessageId: 'a', modelId: 'p/m' };

function getTool(name: string) {
	const tool = createOpenWeatherMapTools('test-key').find((t) => t.definition.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createOpenWeatherMapTools', () => {
	it('registers four tools with stable names', () => {
		const names = createOpenWeatherMapTools('k').map((t) => t.definition.name);
		expect(names).toEqual(['openweather_geocode', 'openweather_reverse_geocode', 'openweather_current', 'openweather_forecast']);
	});
});

describe('openweather_geocode', () => {
	it('rejects missing query', async () => {
		const result = await getTool('openweather_geocode').execute(ctx, {});
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	it('passes appid and limit and returns slim hits', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify([{ name: 'Austin', lat: 30.27, lon: -97.74, country: 'US', state: 'Texas', extra: 'drop' }]), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			);
		const result = await getTool('openweather_geocode').execute(ctx, { query: 'Austin,TX,US', limit: 1 });
		expect(result.isError).toBeFalsy();
		const url = new URL(fetchSpy.mock.calls[0][0] as string);
		expect(url.searchParams.get('q')).toBe('Austin,TX,US');
		expect(url.searchParams.get('limit')).toBe('1');
		expect(url.searchParams.get('appid')).toBe('test-key');
		expect(result.content).toContain('Austin');
		expect(result.content).not.toContain('drop');
	});

	it('returns no-match string for empty array', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
		);
		const result = await getTool('openweather_geocode').execute(ctx, { query: 'Nowhere' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toMatch(/No locations matched/);
	});

	it('surfaces upstream error message', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ message: 'Invalid API key' }), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			}),
		);
		const result = await getTool('openweather_geocode').execute(ctx, { query: 'Austin' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('Invalid API key');
	});
});

describe('openweather_current', () => {
	it('rejects missing coordinates', async () => {
		const result = await getTool('openweather_current').execute(ctx, { lat: 1 });
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe('invalid_input');
	});

	it('returns slim weather payload with units defaulting to metric', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					name: 'Austin',
					dt: 1700000000,
					timezone: -21600,
					coord: { lat: 30.27, lon: -97.74 },
					sys: { country: 'US', sunrise: 1700000000, sunset: 1700040000 },
					weather: [{ id: 800, main: 'Clear', description: 'clear sky', icon: '01d' }],
					main: { temp: 25, feels_like: 24, temp_min: 22, temp_max: 27, pressure: 1013, humidity: 40 },
					wind: { speed: 3.5, deg: 180 },
					clouds: { all: 0 },
					visibility: 10000,
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		);
		const result = await getTool('openweather_current').execute(ctx, { lat: 30.27, lon: -97.74 });
		expect(result.isError).toBeFalsy();
		const url = new URL(fetchSpy.mock.calls[0][0] as string);
		expect(url.searchParams.get('units')).toBe('metric');
		expect(url.searchParams.get('lat')).toBe('30.27');
		expect(result.content).toContain('clear sky');
		expect(result.content).toContain('"temperature": 25');
	});
});

describe('openweather_forecast', () => {
	it('clamps limit and returns entry list', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					city: { name: 'Austin', country: 'US', coord: { lat: 30.27, lon: -97.74 }, timezone: -21600 },
					list: [
						{
							dt: 1700000000,
							dt_txt: '2026-05-04 12:00:00',
							main: { temp: 25, feels_like: 24, humidity: 40, pressure: 1013 },
							weather: [{ id: 800, main: 'Clear', description: 'clear sky', icon: '01d' }],
							wind: { speed: 3.5, deg: 180 },
							clouds: { all: 0 },
							pop: 0.1,
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		);
		const result = await getTool('openweather_forecast').execute(ctx, {
			lat: 30.27,
			lon: -97.74,
			limit: 999,
		});
		expect(result.isError).toBeFalsy();
		const url = new URL(fetchSpy.mock.calls[0][0] as string);
		expect(url.searchParams.get('cnt')).toBe('40');
		expect(result.content).toContain('"count": 1');
		expect(result.content).toContain('clear sky');
	});
});
