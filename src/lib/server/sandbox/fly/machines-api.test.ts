import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	// vi.spyOn caches the wrapper per target+method, so consecutive
	// `stubFetch` calls accumulate into `.mock.calls` unless we reset
	// between tests.
	vi.restoreAllMocks();
});
import {
	FlyApiError,
	createMachine,
	destroyMachine,
	execMachine,
	flyConfigFromEnv,
	getMachine,
	startMachine,
} from './machines-api';

const CFG = { token: 'tok-abc', appName: 'sandbox-app', appHostname: 'sandbox-app.fly.dev' };

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
		return handler(String(url), init as RequestInit);
	});
}

describe('flyConfigFromEnv', () => {
	it('returns null when token is missing', () => {
		expect(flyConfigFromEnv({ FLY_APP_NAME: 'a' } as unknown as Env)).toBeNull();
	});
	it('returns null when app name is missing', () => {
		expect(flyConfigFromEnv({ FLY_API_TOKEN: 't' } as unknown as Env)).toBeNull();
	});
	it('derives default hostname when override is absent', () => {
		const cfg = flyConfigFromEnv({ FLY_API_TOKEN: 't', FLY_APP_NAME: 'a' } as unknown as Env);
		expect(cfg?.appHostname).toBe('a.fly.dev');
	});
	it('honors the FLY_APP_HOSTNAME override', () => {
		const cfg = flyConfigFromEnv({
			FLY_API_TOKEN: 't',
			FLY_APP_NAME: 'a',
			FLY_APP_HOSTNAME: 'preview.example.com',
		} as unknown as Env);
		expect(cfg?.appHostname).toBe('preview.example.com');
	});
});

describe('machines-api REST', () => {
	it('sends Bearer auth and JSON body for createMachine', async () => {
		const spy = stubFetch(() =>
			new Response(JSON.stringify({ id: 'm-1', state: 'created' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
		const created = await createMachine(CFG, { config: { image: 'r/x:latest' } });
		expect(created.id).toBe('m-1');
		const [url, init] = spy.mock.calls[0];
		expect(String(url)).toBe('https://api.machines.dev/v1/apps/sandbox-app/machines');
		const headers = new Headers((init as RequestInit).headers);
		expect(headers.get('authorization')).toBe('Bearer tok-abc');
		expect(headers.get('content-type')).toBe('application/json');
		expect((init as RequestInit).method).toBe('POST');
	});

	it('getMachine returns null on 404 instead of throwing', async () => {
		stubFetch(() => new Response('not found', { status: 404 }));
		const result = await getMachine(CFG, 'missing');
		expect(result).toBeNull();
	});

	it('getMachine throws FlyApiError on non-404 failures', async () => {
		stubFetch(() => new Response('rate limited', { status: 429 }));
		await expect(getMachine(CFG, 'm-1')).rejects.toBeInstanceOf(FlyApiError);
	});

	it('startMachine POSTs to the start endpoint', async () => {
		const spy = stubFetch(() => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
		await startMachine(CFG, 'm-42');
		expect(String(spy.mock.calls[0][0])).toBe(
			'https://api.machines.dev/v1/apps/sandbox-app/machines/m-42/start',
		);
		expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST');
	});

	it('destroyMachine tolerates 404 (already-destroyed)', async () => {
		stubFetch(() => new Response('', { status: 404 }));
		await expect(destroyMachine(CFG, 'gone')).resolves.toBeUndefined();
	});

	it('destroyMachine throws on other failures', async () => {
		stubFetch(() => new Response('forbidden', { status: 403 }));
		await expect(destroyMachine(CFG, 'm-1')).rejects.toBeInstanceOf(FlyApiError);
	});

	it('execMachine returns the parsed body verbatim', async () => {
		stubFetch(
			() =>
				new Response(JSON.stringify({ exit_code: 0, stdout: 'hi', stderr: '' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		);
		const r = await execMachine(CFG, 'm-1', { cmd: ['echo', 'hi'] });
		expect(r).toEqual({ exit_code: 0, stdout: 'hi', stderr: '' });
	});
});
