import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	// vi.spyOn caches the wrapper per target+method, so consecutive
	// `stubFetch` calls accumulate into `.mock.calls` unless we reset
	// between tests.
	vi.restoreAllMocks();
});

import { createMachine, destroyMachine, execMachine, FlyApiError, flyConfigFromEnv, getMachine, startMachine } from './machines-api';

const CFG = { appHostname: 'sandbox-app.fly.dev', appName: 'sandbox-app', token: 'tok-abc' };

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
			FLY_APP_HOSTNAME: 'preview.example.com',
			FLY_APP_NAME: 'a',
		} as unknown as Env);
		expect(cfg?.appHostname).toBe('preview.example.com');
	});
});

describe('machines-api REST', () => {
	it('sends Bearer auth and JSON body for createMachine', async () => {
		const spy = stubFetch(
			() =>
				new Response(JSON.stringify({ id: 'm-1', state: 'created' }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
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
		const spy = stubFetch(() => new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' }, status: 200 }));
		await startMachine(CFG, 'm-42');
		expect(String(spy.mock.calls[0][0])).toBe('https://api.machines.dev/v1/apps/sandbox-app/machines/m-42/start');
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
				new Response(JSON.stringify({ exit_code: 0, stderr: '', stdout: 'hi' }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
		);
		const r = await execMachine(CFG, 'm-1', { cmd: ['echo', 'hi'] });
		expect(r).toEqual({ exit_code: 0, stderr: '', stdout: 'hi' });
	});

	it('execMachine normalises null stdout/stderr to empty strings', async () => {
		// Regression: fly's API has been observed to return `null` rather
		// than `""` for empty output streams. The Zod schema accepts
		// either and downstream callers always see a string.
		stubFetch(
			() =>
				new Response(JSON.stringify({ exit_code: 0, stderr: null, stdout: null }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
		);
		const r = await execMachine(CFG, 'm-1', { cmd: ['true'] });
		expect(r.stdout).toBe('');
		expect(r.stderr).toBe('');
	});

	it('getMachine raises FlyApiError when the response shape drifts', async () => {
		// If fly's API ever drops the `state` field (or changes its enum),
		// we want a clear validation error rather than an `undefined`
		// silently flowing into lifecycle logic.
		stubFetch(
			() =>
				new Response(JSON.stringify({ id: 'm-1' /* no state */ }), {
					headers: { 'content-type': 'application/json' },
					status: 200,
				}),
		);
		await expect(getMachine(CFG, 'm-1')).rejects.toThrow(/failed validation/);
	});

	it('createMachine validates the outgoing body before sending', async () => {
		// The outbound-body schema catches local mistakes (a missing
		// required `image`, a typo'd field) before we pay the round trip.
		const spy = stubFetch(() => new Response(JSON.stringify({ id: 'm-1', state: 'created' }), { status: 200 }));
		await expect(
			// @ts-expect-error — intentionally missing the required `image`
			createMachine(CFG, { config: { env: { FOO: 'bar' } } }),
		).rejects.toThrow();
		expect(spy).not.toHaveBeenCalled();
	});

	it('inlines the fly response body in error.message on 422', async () => {
		// Regression: a 422 from fly used to surface only "→ 422" with
		// the actual reason hidden in `.body`. Callers that render
		// `error.message` should see *why* fly rejected the request.
		stubFetch(() => new Response('{"error":"image not found"}', { status: 422 }));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = await createMachine(CFG, { config: { image: 'r/x:latest' } }).catch((e) => e);
		expect(err).toBeInstanceOf(FlyApiError);
		expect(err.message).toContain('422');
		expect(err.message).toContain('image not found');
		expect(err.body).toBe('{"error":"image not found"}');
	});

	it('emits a structured console.error with method/path/status/responseBody on failure', async () => {
		// Regression: without a console.error at the throw site, wrangler
		// tail showed nothing useful when fly rejected a request.
		stubFetch(() => new Response('{"error":"image not found"}', { status: 422 }));
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await createMachine(CFG, { config: { image: 'r/x:latest' } }).catch(() => {});
		expect(errSpy).toHaveBeenCalledTimes(1);
		const [label, ctx] = errSpy.mock.calls[0];
		expect(label).toBe('Fly API error');
		expect(ctx).toMatchObject({
			method: 'POST',
			path: '/apps/sandbox-app/machines',
			responseBody: '{"error":"image not found"}',
			status: 422,
		});
		expect(typeof (ctx as { requestBody?: unknown }).requestBody).toBe('string');
		expect((ctx as { requestBody: string }).requestBody).toContain('r/x:latest');
	});

	it('never leaks the bearer token into error logs', async () => {
		// Defensive: the token lives in the Authorization header, never
		// the body, so the helper has no reason to log it. This guards
		// against a future change that adds header logging without
		// thinking about secrets.
		stubFetch(() => new Response('{"error":"image not found"}', { status: 422 }));
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await createMachine(CFG, { config: { image: 'r/x:latest' } }).catch(() => {});
		for (const call of errSpy.mock.calls) {
			const serialized = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
			expect(serialized).not.toContain('tok-abc');
		}
	});
});
