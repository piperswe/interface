import type { Tool, ToolContext, ToolExecutionResult } from './registry';

// OpenWeatherMap free-tier endpoints. All require an `appid` query
// parameter. We use the data 2.5 endpoints plus the geocoding API,
// which together work with a default free key.
const GEOCODE_URL = 'https://api.openweathermap.org/geo/1.0/direct';
const REVERSE_GEOCODE_URL = 'https://api.openweathermap.org/geo/1.0/reverse';
const CURRENT_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';

type Units = 'standard' | 'metric' | 'imperial';

const unitsSchema = {
	type: 'string',
	enum: ['standard', 'metric', 'imperial'],
	description:
		'Unit system: "standard" (Kelvin, m/s), "metric" (Celsius, m/s), or "imperial" (Fahrenheit, mph). Defaults to "metric".',
} as const;

const langSchema = {
	type: 'string',
	description:
		'ISO 639-1 language code for localized weather descriptions (e.g. "en", "es", "fr"). Defaults to "en".',
} as const;

function ok(content: unknown): ToolExecutionResult {
	return { content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) };
}

function err(
	message: string,
	errorCode: 'invalid_input' | 'execution_failure' = 'execution_failure',
): ToolExecutionResult {
	return { content: message, isError: true, errorCode };
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
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
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
		return { ok: false, error: `OpenWeatherMap error: ${message}` };
	}
	return { ok: true, data: body };
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
			name: 'openweather_geocode',
			description:
				'Resolve a free-text location (city name, optionally with state/country) into geographic coordinates using OpenWeatherMap\'s geocoding API. Returns up to `limit` candidate places with lat/lon, country, and state. Use this first to obtain coordinates for the other openweather_* tools.',
			inputSchema: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							'Location to look up. Free text "city", "city,state", or "city,state,country" (ISO 3166 country code). Example: "Austin,TX,US".',
					},
					limit: {
						type: 'integer',
						minimum: 1,
						maximum: 5,
						description: 'Maximum number of candidate locations to return. Defaults to 5.',
					},
				},
				required: ['query'],
			},
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const args = (input ?? {}) as { query?: string; limit?: number };
			if (!args.query || typeof args.query !== 'string') {
				return err('Missing required parameter: query', 'invalid_input');
			}
			const limit = Math.min(Math.max(args.limit ?? 5, 1), 5);
			const result = await callOpenWeather(
				GEOCODE_URL,
				{ q: args.query, limit: String(limit) },
				apiKey,
				ctx.signal,
			);
			if (!result.ok) return err(result.error);
			const hits = (result.data as GeocodeHit[] | null) ?? [];
			if (hits.length === 0) return ok(`No locations matched "${args.query}".`);
			return ok(
				hits.map((h) => ({
					name: h.name,
					lat: h.lat,
					lon: h.lon,
					country: h.country,
					state: h.state,
				})),
			);
		},
	};
}

function reverseGeocodeTool(apiKey: string): Tool {
	return {
		definition: {
			name: 'openweather_reverse_geocode',
			description:
				'Reverse-geocode latitude/longitude into nearby place names using OpenWeatherMap\'s geocoding API. Useful for labeling coordinates returned by other tools.',
			inputSchema: {
				type: 'object',
				properties: {
					lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude in decimal degrees.' },
					lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude in decimal degrees.' },
					limit: {
						type: 'integer',
						minimum: 1,
						maximum: 5,
						description: 'Maximum number of candidate places to return. Defaults to 1.',
					},
				},
				required: ['lat', 'lon'],
			},
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const args = (input ?? {}) as { lat?: number; lon?: number; limit?: number };
			if (!isFiniteNumber(args.lat)) return err('Missing or invalid parameter: lat', 'invalid_input');
			if (!isFiniteNumber(args.lon)) return err('Missing or invalid parameter: lon', 'invalid_input');
			const limit = Math.min(Math.max(args.limit ?? 1, 1), 5);
			const result = await callOpenWeather(
				REVERSE_GEOCODE_URL,
				{ lat: String(args.lat), lon: String(args.lon), limit: String(limit) },
				apiKey,
				ctx.signal,
			);
			if (!result.ok) return err(result.error);
			const hits = (result.data as GeocodeHit[] | null) ?? [];
			if (hits.length === 0) return ok(`No places found near (${args.lat}, ${args.lon}).`);
			return ok(
				hits.map((h) => ({
					name: h.name,
					lat: h.lat,
					lon: h.lon,
					country: h.country,
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
			name: 'openweather_current',
			description:
				'Get current weather conditions for a location by latitude/longitude using OpenWeatherMap. Returns temperature, feels-like, humidity, wind, conditions summary, and sunrise/sunset times. Use openweather_geocode first if you only have a place name.',
			inputSchema: {
				type: 'object',
				properties: {
					lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude in decimal degrees.' },
					lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude in decimal degrees.' },
					units: unitsSchema,
					lang: langSchema,
				},
				required: ['lat', 'lon'],
			},
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const args = (input ?? {}) as { lat?: number; lon?: number; units?: Units; lang?: string };
			if (!isFiniteNumber(args.lat)) return err('Missing or invalid parameter: lat', 'invalid_input');
			if (!isFiniteNumber(args.lon)) return err('Missing or invalid parameter: lon', 'invalid_input');
			const units = args.units ?? 'metric';
			const result = await callOpenWeather(
				CURRENT_URL,
				{
					lat: String(args.lat),
					lon: String(args.lon),
					units,
					lang: args.lang ?? 'en',
				},
				apiKey,
				ctx.signal,
			);
			if (!result.ok) return err(result.error);
			const data = result.data as CurrentWeatherResponse;
			return ok({
				location: {
					name: data.name,
					country: data.sys?.country,
					lat: data.coord?.lat,
					lon: data.coord?.lon,
					timezone_offset_seconds: data.timezone,
				},
				observed_at_unix: data.dt,
				conditions: summarizeWeatherEntries(data.weather),
				temperature: data.main?.temp,
				feels_like: data.main?.feels_like,
				temp_min: data.main?.temp_min,
				temp_max: data.main?.temp_max,
				humidity_percent: data.main?.humidity,
				pressure_hpa: data.main?.pressure,
				wind_speed: data.wind?.speed,
				wind_deg: data.wind?.deg,
				wind_gust: data.wind?.gust,
				cloudiness_percent: data.clouds?.all,
				visibility_meters: data.visibility,
				rain_mm: data.rain?.['1h'] ?? data.rain?.['3h'],
				snow_mm: data.snow?.['1h'] ?? data.snow?.['3h'],
				sunrise_unix: data.sys?.sunrise,
				sunset_unix: data.sys?.sunset,
				units,
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
			name: 'openweather_forecast',
			description:
				'5-day / 3-hour weather forecast for a location by latitude/longitude using OpenWeatherMap. Returns up to 40 forecast entries spaced 3 hours apart. Pass `limit` to cap the count for a more compact response.',
			inputSchema: {
				type: 'object',
				properties: {
					lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude in decimal degrees.' },
					lon: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude in decimal degrees.' },
					units: unitsSchema,
					lang: langSchema,
					limit: {
						type: 'integer',
						minimum: 1,
						maximum: 40,
						description:
							'Maximum number of 3-hour forecast entries to return (most recent first). Defaults to 16 (~2 days).',
					},
				},
				required: ['lat', 'lon'],
			},
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const args = (input ?? {}) as {
				lat?: number;
				lon?: number;
				units?: Units;
				lang?: string;
				limit?: number;
			};
			if (!isFiniteNumber(args.lat)) return err('Missing or invalid parameter: lat', 'invalid_input');
			if (!isFiniteNumber(args.lon)) return err('Missing or invalid parameter: lon', 'invalid_input');
			const units = args.units ?? 'metric';
			const limit = Math.min(Math.max(args.limit ?? 16, 1), 40);
			const result = await callOpenWeather(
				FORECAST_URL,
				{
					lat: String(args.lat),
					lon: String(args.lon),
					units,
					lang: args.lang ?? 'en',
					cnt: String(limit),
				},
				apiKey,
				ctx.signal,
			);
			if (!result.ok) return err(result.error);
			const data = result.data as ForecastResponse;
			const entries = (data.list ?? []).map((e) => ({
				time_unix: e.dt,
				time_iso: e.dt_txt,
				conditions: summarizeWeatherEntries(e.weather),
				temperature: e.main.temp,
				feels_like: e.main.feels_like,
				humidity_percent: e.main.humidity,
				pressure_hpa: e.main.pressure,
				wind_speed: e.wind.speed,
				wind_deg: e.wind.deg,
				wind_gust: e.wind.gust,
				cloudiness_percent: e.clouds.all,
				probability_of_precipitation: e.pop,
				rain_mm_3h: e.rain?.['3h'],
				snow_mm_3h: e.snow?.['3h'],
			}));
			return ok({
				location: {
					name: data.city?.name,
					country: data.city?.country,
					lat: data.city?.coord?.lat,
					lon: data.city?.coord?.lon,
					timezone_offset_seconds: data.city?.timezone,
					sunrise_unix: data.city?.sunrise,
					sunset_unix: data.city?.sunset,
				},
				units,
				count: entries.length,
				entries,
			});
		},
	};
}

// Returns every OpenWeatherMap tool. The caller decides whether to register
// them based on whether OPENWEATHERMAP_KEY is configured.
export function createOpenWeatherMapTools(apiKey: string): Tool[] {
	return [
		geocodeTool(apiKey),
		reverseGeocodeTool(apiKey),
		currentWeatherTool(apiKey),
		forecastTool(apiKey),
	];
}
