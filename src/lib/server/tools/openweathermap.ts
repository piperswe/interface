import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import type { Tool, ToolContext, ToolExecutionResult } from './registry';

// OpenWeatherMap free-tier endpoints. All require an `appid` query
// parameter. We use the data 2.5 endpoints plus the geocoding API,
// which together work with a default free key.
const GEOCODE_URL = 'https://api.openweathermap.org/geo/1.0/direct';
const REVERSE_GEOCODE_URL = 'https://api.openweathermap.org/geo/1.0/reverse';
const CURRENT_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';

const unitsZ = z.enum(['standard', 'metric', 'imperial']);
const geocodeArgs = z.object({
	limit: z.number().optional(),
	query: z.string(),
});
const reverseGeocodeArgs = z.object({
	lat: z.number(),
	limit: z.number().optional(),
	lon: z.number(),
});
const currentArgs = z.object({
	lang: z.string().optional(),
	lat: z.number(),
	lon: z.number(),
	units: unitsZ.optional(),
});
const forecastArgs = z.object({
	lang: z.string().optional(),
	lat: z.number(),
	limit: z.number().optional(),
	lon: z.number(),
	units: unitsZ.optional(),
});

const unitsSchema = {
	description: 'Unit system: "standard" (Kelvin, m/s), "metric" (Celsius, m/s), or "imperial" (Fahrenheit, mph). Defaults to "metric".',
	enum: ['standard', 'metric', 'imperial'],
	type: 'string',
} as const;

const langSchema = {
	description: 'ISO 639-1 language code for localized weather descriptions (e.g. "en", "es", "fr"). Defaults to "en".',
	type: 'string',
} as const;

function ok(content: unknown): ToolExecutionResult {
	return { content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) };
}

function err(message: string, errorCode: 'invalid_input' | 'execution_failure' = 'execution_failure'): ToolExecutionResult {
	return { content: message, errorCode, isError: true };
}

async function callOpenWeather(
	url: string,
	params: Record<string, string>,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
	const u = new URL(url);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
	u.searchParams.set('appid', apiKey);
	let res: Response;
	try {
		res = await fetch(u.toString(), { signal });
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e), ok: false };
	}
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		// Non-JSON body — fall through with whatever status we have.
	}
	if (!res.ok) {
		const message =
			body && typeof body === 'object' && 'message' in body
				? String((body as { message: unknown }).message)
				: `HTTP ${res.status} ${res.statusText}`;
		return { error: `OpenWeatherMap error: ${message}`, ok: false };
	}
	return { data: body, ok: true };
}

type GeocodeHit = {
	name: string;
	local_names?: Record<string, string>;
	lat: number;
	lon: number;
	country: string;
	state?: string;
};

function geocodeTool(apiKey: string): Tool {
	return {
		definition: {
			description:
				"Resolve a free-text location (city name, optionally with state/country) into geographic coordinates using OpenWeatherMap's geocoding API. Returns up to `limit` candidate places with lat/lon, country, and state. Use this first to obtain coordinates for the other openweather_* tools.",
			inputSchema: {
				properties: {
					limit: {
						description: 'Maximum number of candidate locations to return. Defaults to 5.',
						maximum: 5,
						minimum: 1,
						type: 'integer',
					},
					query: {
						description:
							'Location to look up. Free text "city", "city,state", or "city,state,country" (ISO 3166 country code). Example: "Austin,TX,US".',
						type: 'string',
					},
				},
				required: ['query'],
				type: 'object',
			},
			name: 'openweather_geocode',
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(geocodeArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const limit = Math.min(Math.max(args.limit ?? 5, 1), 5);
			const result = await callOpenWeather(GEOCODE_URL, { limit: String(limit), q: args.query }, apiKey, ctx.signal);
			if (!result.ok) return err(result.error);
			const hits = (result.data as GeocodeHit[] | null) ?? [];
			if (hits.length === 0) return ok(`No locations matched "${args.query}".`);
			return ok(
				hits.map((h) => ({
					country: h.country,
					lat: h.lat,
					lon: h.lon,
					name: h.name,
					state: h.state,
				})),
			);
		},
	};
}

function reverseGeocodeTool(apiKey: string): Tool {
	return {
		definition: {
			description:
				"Reverse-geocode latitude/longitude into nearby place names using OpenWeatherMap's geocoding API. Useful for labeling coordinates returned by other tools.",
			inputSchema: {
				properties: {
					lat: { description: 'Latitude in decimal degrees.', maximum: 90, minimum: -90, type: 'number' },
					limit: {
						description: 'Maximum number of candidate places to return. Defaults to 1.',
						maximum: 5,
						minimum: 1,
						type: 'integer',
					},
					lon: { description: 'Longitude in decimal degrees.', maximum: 180, minimum: -180, type: 'number' },
				},
				required: ['lat', 'lon'],
				type: 'object',
			},
			name: 'openweather_reverse_geocode',
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(reverseGeocodeArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const limit = Math.min(Math.max(args.limit ?? 1, 1), 5);
			const result = await callOpenWeather(
				REVERSE_GEOCODE_URL,
				{ lat: String(args.lat), limit: String(limit), lon: String(args.lon) },
				apiKey,
				ctx.signal,
			);
			if (!result.ok) return err(result.error);
			const hits = (result.data as GeocodeHit[] | null) ?? [];
			if (hits.length === 0) return ok(`No places found near (${args.lat}, ${args.lon}).`);
			return ok(
				hits.map((h) => ({
					country: h.country,
					lat: h.lat,
					lon: h.lon,
					name: h.name,
					state: h.state,
				})),
			);
		},
	};
}

type CurrentWeatherResponse = {
	name?: string;
	dt?: number;
	timezone?: number;
	coord?: { lat: number; lon: number };
	sys?: { country?: string; sunrise?: number; sunset?: number };
	weather?: Array<{ id: number; main: string; description: string; icon: string }>;
	main?: {
		temp: number;
		feels_like: number;
		temp_min: number;
		temp_max: number;
		pressure: number;
		humidity: number;
	};
	wind?: { speed: number; deg: number; gust?: number };
	clouds?: { all: number };
	rain?: { '1h'?: number; '3h'?: number };
	snow?: { '1h'?: number; '3h'?: number };
	visibility?: number;
};

function summarizeWeatherEntries(weather: CurrentWeatherResponse['weather']): string | undefined {
	if (!weather || weather.length === 0) return undefined;
	return weather.map((w) => w.description).join(', ');
}

function currentWeatherTool(apiKey: string): Tool {
	return {
		definition: {
			description:
				'Get current weather conditions for a location by latitude/longitude using OpenWeatherMap. Returns temperature, feels-like, humidity, wind, conditions summary, and sunrise/sunset times. Use openweather_geocode first if you only have a place name.',
			inputSchema: {
				properties: {
					lang: langSchema,
					lat: { description: 'Latitude in decimal degrees.', maximum: 90, minimum: -90, type: 'number' },
					lon: { description: 'Longitude in decimal degrees.', maximum: 180, minimum: -180, type: 'number' },
					units: unitsSchema,
				},
				required: ['lat', 'lon'],
				type: 'object',
			},
			name: 'openweather_current',
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(currentArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const units = args.units ?? 'metric';
			const result = await callOpenWeather(
				CURRENT_URL,
				{
					lang: args.lang ?? 'en',
					lat: String(args.lat),
					lon: String(args.lon),
					units,
				},
				apiKey,
				ctx.signal,
			);
			if (!result.ok) return err(result.error);
			const data = result.data as CurrentWeatherResponse;
			return ok({
				cloudiness_percent: data.clouds?.all,
				conditions: summarizeWeatherEntries(data.weather),
				feels_like: data.main?.feels_like,
				humidity_percent: data.main?.humidity,
				location: {
					country: data.sys?.country,
					lat: data.coord?.lat,
					lon: data.coord?.lon,
					name: data.name,
					timezone_offset_seconds: data.timezone,
				},
				observed_at_unix: data.dt,
				pressure_hpa: data.main?.pressure,
				rain_mm: data.rain?.['1h'] ?? data.rain?.['3h'],
				snow_mm: data.snow?.['1h'] ?? data.snow?.['3h'],
				sunrise_unix: data.sys?.sunrise,
				sunset_unix: data.sys?.sunset,
				temp_max: data.main?.temp_max,
				temp_min: data.main?.temp_min,
				temperature: data.main?.temp,
				units,
				visibility_meters: data.visibility,
				wind_deg: data.wind?.deg,
				wind_gust: data.wind?.gust,
				wind_speed: data.wind?.speed,
			});
		},
	};
}

type ForecastResponse = {
	city?: {
		name?: string;
		country?: string;
		coord?: { lat: number; lon: number };
		timezone?: number;
		sunrise?: number;
		sunset?: number;
	};
	list?: Array<{
		dt: number;
		dt_txt: string;
		main: { temp: number; feels_like: number; humidity: number; pressure: number };
		weather: Array<{ id: number; main: string; description: string; icon: string }>;
		wind: { speed: number; deg: number; gust?: number };
		clouds: { all: number };
		pop?: number;
		rain?: { '3h'?: number };
		snow?: { '3h'?: number };
	}>;
};

function forecastTool(apiKey: string): Tool {
	return {
		definition: {
			description:
				'5-day / 3-hour weather forecast for a location by latitude/longitude using OpenWeatherMap. Returns up to 40 forecast entries spaced 3 hours apart. Pass `limit` to cap the count for a more compact response.',
			inputSchema: {
				properties: {
					lang: langSchema,
					lat: { description: 'Latitude in decimal degrees.', maximum: 90, minimum: -90, type: 'number' },
					limit: {
						description: 'Maximum number of 3-hour forecast entries to return (most recent first). Defaults to 16 (~2 days).',
						maximum: 40,
						minimum: 1,
						type: 'integer',
					},
					lon: { description: 'Longitude in decimal degrees.', maximum: 180, minimum: -180, type: 'number' },
					units: unitsSchema,
				},
				required: ['lat', 'lon'],
				type: 'object',
			},
			name: 'openweather_forecast',
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(forecastArgs, input);
			if (!parsed.ok) return err(`Invalid input: ${parsed.error}`, 'invalid_input');
			const args = parsed.value;
			const units = args.units ?? 'metric';
			const limit = Math.min(Math.max(args.limit ?? 16, 1), 40);
			const result = await callOpenWeather(
				FORECAST_URL,
				{
					cnt: String(limit),
					lang: args.lang ?? 'en',
					lat: String(args.lat),
					lon: String(args.lon),
					units,
				},
				apiKey,
				ctx.signal,
			);
			if (!result.ok) return err(result.error);
			const data = result.data as ForecastResponse;
			const entries = (data.list ?? []).map((e) => ({
				cloudiness_percent: e.clouds.all,
				conditions: summarizeWeatherEntries(e.weather),
				feels_like: e.main.feels_like,
				humidity_percent: e.main.humidity,
				pressure_hpa: e.main.pressure,
				probability_of_precipitation: e.pop,
				rain_mm_3h: e.rain?.['3h'],
				snow_mm_3h: e.snow?.['3h'],
				temperature: e.main.temp,
				time_iso: e.dt_txt,
				time_unix: e.dt,
				wind_deg: e.wind.deg,
				wind_gust: e.wind.gust,
				wind_speed: e.wind.speed,
			}));
			return ok({
				count: entries.length,
				entries,
				location: {
					country: data.city?.country,
					lat: data.city?.coord?.lat,
					lon: data.city?.coord?.lon,
					name: data.city?.name,
					sunrise_unix: data.city?.sunrise,
					sunset_unix: data.city?.sunset,
					timezone_offset_seconds: data.city?.timezone,
				},
				units,
			});
		},
	};
}

// Returns every OpenWeatherMap tool. The caller decides whether to register
// them based on whether OPENWEATHERMAP_KEY is configured.
export function createOpenWeatherMapTools(apiKey: string): Tool[] {
	return [geocodeTool(apiKey), reverseGeocodeTool(apiKey), currentWeatherTool(apiKey), forecastTool(apiKey)];
}
