import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenWeatherMapTools } from './openweathermap';

const ctx = { assistantMessageId: 'a', conversationId: 'c', env, modelId: 'p/m' };

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
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify([{ country: 'US', extra: 'drop', lat: 30.27, lon: -97.74, name: 'Austin', state: 'Texas' }]), {
				headers: { 'content-type': 'application/json' },
				status: 200,
			}),
		);
		const result = await getTool('openweather_geocode').execute(ctx, { limit: 1, query: 'Austin,TX,US' });
		expect(result.isError).toBeFalsy();
		const url = new URL(fetchSpy.mock.calls[0][0] as string);
		expect(url.searchParams.get('q')).toBe('Austin,TX,US');
		expect(url.searchParams.get('limit')).toBe('1');
		expect(url.searchParams.get('appid')).toBe('test-key');
		expect(result.content).toContain('Austin');
		expect(result.content).not.toContain('drop');
	});

	it('returns no-match string for empty array', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('[]', { headers: { 'content-type': 'application/json' }, status: 200 }));
		const result = await getTool('openweather_geocode').execute(ctx, { query: 'Nowhere' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toMatch(/No locations matched/);
	});

	it('surfaces upstream error message', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ message: 'Invalid API key' }), {
				headers: { 'content-type': 'application/json' },
				status: 401,
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
					clouds: { all: 0 },
					coord: { lat: 30.27, lon: -97.74 },
					dt: 1700000000,
					main: { feels_like: 24, humidity: 40, pressure: 1013, temp: 25, temp_max: 27, temp_min: 22 },
					name: 'Austin',
					sys: { country: 'US', sunrise: 1700000000, sunset: 1700040000 },
					timezone: -21600,
					visibility: 10000,
					weather: [{ description: 'clear sky', icon: '01d', id: 800, main: 'Clear' }],
					wind: { deg: 180, speed: 3.5 },
				}),
				{ headers: { 'content-type': 'application/json' }, status: 200 },
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
					city: { coord: { lat: 30.27, lon: -97.74 }, country: 'US', name: 'Austin', timezone: -21600 },
					list: [
						{
							clouds: { all: 0 },
							dt: 1700000000,
							dt_txt: '2026-05-04 12:00:00',
							main: { feels_like: 24, humidity: 40, pressure: 1013, temp: 25 },
							pop: 0.1,
							weather: [{ description: 'clear sky', icon: '01d', id: 800, main: 'Clear' }],
							wind: { deg: 180, speed: 3.5 },
						},
					],
				}),
				{ headers: { 'content-type': 'application/json' }, status: 200 },
			),
		);
		const result = await getTool('openweather_forecast').execute(ctx, {
			lat: 30.27,
			limit: 999,
			lon: -97.74,
		});
		expect(result.isError).toBeFalsy();
		const url = new URL(fetchSpy.mock.calls[0][0] as string);
		expect(url.searchParams.get('cnt')).toBe('40');
		expect(result.content).toContain('"count": 1');
		expect(result.content).toContain('clear sky');
	});
});
