import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createProvider,
	deleteProvider,
	getProvider,
	isValidProviderId,
	listProviders,
	updateProvider,
	_assertValidEndpoint,
} from './store';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM provider_models').run();
	await env.DB.prepare('DELETE FROM providers').run();
});

describe('isValidProviderId', () => {
	it('accepts snake/kebab case beginning with a letter', () => {
		expect(isValidProviderId('openrouter')).toBe(true);
		expect(isValidProviderId('ai-gateway')).toBe(true);
		expect(isValidProviderId('workers_ai')).toBe(true);
		expect(isValidProviderId('a')).toBe(true);
	});
	it('rejects ids that start with a digit or are uppercase', () => {
		expect(isValidProviderId('1openrouter')).toBe(false);
		expect(isValidProviderId('OpenRouter')).toBe(false);
	});
	it('rejects ids containing spaces or punctuation', () => {
		expect(isValidProviderId('open router')).toBe(false);
		expect(isValidProviderId('open.router')).toBe(false);
		expect(isValidProviderId('open/router')).toBe(false);
	});
	it('rejects empty string', () => {
		expect(isValidProviderId('')).toBe(false);
	});
	it('rejects ids longer than 64 characters', () => {
		expect(isValidProviderId('a'.repeat(64))).toBe(true); // boundary OK
		expect(isValidProviderId('a'.repeat(65))).toBe(false);
	});
});

describe('createProvider + getProvider + listProviders', () => {
	it('round-trips a provider with all optional fields set', async () => {
		await createProvider(env, {
			id: 'p1',
			type: 'openai_compatible',
			apiKey: 'sk-1',
			endpoint: 'https://api.example/v1',
			gatewayId: 'gw',
		});
		const row = await getProvider(env, 'p1');
		expect(row).toMatchObject({
			id: 'p1',
			type: 'openai_compatible',
			apiKey: 'sk-1',
			endpoint: 'https://api.example/v1',
			gatewayId: 'gw',
		});
		expect(row?.createdAt).toBeGreaterThan(0);
		expect(row?.updatedAt).toBe(row?.createdAt);
	});

	it('defaults optional fields to null', async () => {
		await createProvider(env, { id: 'p2', type: 'anthropic' });
		const row = await getProvider(env, 'p2');
		expect(row?.apiKey).toBeNull();
		expect(row?.endpoint).toBeNull();
		expect(row?.gatewayId).toBeNull();
	});

	it('listProviders orders by created_at ASC', async () => {
		await createProvider(env, { id: 'first', type: 'anthropic' });
		await new Promise((r) => setTimeout(r, 5));
		await createProvider(env, { id: 'second', type: 'anthropic' });
		const rows = await listProviders(env);
		expect(rows.map((r) => r.id)).toEqual(['first', 'second']);
	});

	it('getProvider returns null for unknown id', async () => {
		expect(await getProvider(env, 'missing')).toBeNull();
	});

	it('isolates list / get queries per user_id', async () => {
		// The providers table has a global PRIMARY KEY on id, so the same id
		// cannot exist under two user_ids in the same database; all single-user
		// installs reserve user_id=1. Confirm the query filters still scope
		// reads correctly when distinct ids are stored under different users.
		await createProvider(env, { id: 'u1-only', type: 'anthropic' }, 1);
		await createProvider(env, { id: 'u2-only', type: 'anthropic' }, 2);
		expect((await listProviders(env, 1)).map((r) => r.id)).toEqual(['u1-only']);
		expect((await listProviders(env, 2)).map((r) => r.id)).toEqual(['u2-only']);
		expect(await getProvider(env, 'u1-only', 1)).not.toBeNull();
		expect(await getProvider(env, 'u1-only', 2)).toBeNull();
	});
});

describe('updateProvider', () => {
	it('patches individual fields without disturbing others', async () => {
		await createProvider(env, {
			id: 'p1',
			type: 'openai_compatible',
			apiKey: 'sk-1',
			endpoint: 'https://api.example/v1',
		});
		await updateProvider(env, 'p1', { apiKey: 'sk-2' });
		const after = await getProvider(env, 'p1');
		expect(after?.apiKey).toBe('sk-2');
		expect(after?.endpoint).toBe('https://api.example/v1');
	});

	it('clears nullable fields when explicitly set to null', async () => {
		await createProvider(env, { id: 'p1', type: 'openai_compatible', apiKey: 'sk-1', endpoint: 'https://x/v1' });
		await updateProvider(env, 'p1', { apiKey: null, endpoint: null, gatewayId: null });
		const after = await getProvider(env, 'p1');
		expect(after?.apiKey).toBeNull();
		expect(after?.endpoint).toBeNull();
		expect(after?.gatewayId).toBeNull();
	});

	it('is a no-op when input is empty', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic', apiKey: 'sk-1' });
		const before = await getProvider(env, 'p1');
		await updateProvider(env, 'p1', {});
		const after = await getProvider(env, 'p1');
		// updated_at is untouched when no fields change.
		expect(after?.updatedAt).toBe(before?.updatedAt);
		expect(after?.apiKey).toBe('sk-1');
	});

	it('bumps updated_at when at least one field changes', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic', apiKey: 'sk-1' });
		const before = await getProvider(env, 'p1');
		await new Promise((r) => setTimeout(r, 5));
		await updateProvider(env, 'p1', { apiKey: 'sk-2' });
		const after = await getProvider(env, 'p1');
		expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt);
	});

	it('is scoped by user_id', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic', apiKey: 'sk-1' }, 1);
		await updateProvider(env, 'p1', { apiKey: 'hijacked' }, 2); // wrong user
		expect((await getProvider(env, 'p1', 1))?.apiKey).toBe('sk-1');
	});
});

describe('deleteProvider', () => {
	it('removes the row outright', async () => {
		await createProvider(env, { id: 'p1', type: 'anthropic' });
		await deleteProvider(env, 'p1');
		expect(await getProvider(env, 'p1')).toBeNull();
	});

	it('is scoped by user_id (refuses to delete another user\'s row)', async () => {
		// providers.id is globally unique so the same id can't exist under
		// two users. Verify the `user_id` guard still prevents a wrong-user
		// caller from deleting an existing row.
		await createProvider(env, { id: 'p-user1', type: 'anthropic' }, 1);
		await deleteProvider(env, 'p-user1', 2); // wrong user — no-op
		expect(await getProvider(env, 'p-user1', 1)).not.toBeNull();
		await deleteProvider(env, 'p-user1', 1);
		expect(await getProvider(env, 'p-user1', 1)).toBeNull();
	});

	it('is a no-op for unknown ids', async () => {
		// Should not throw.
		await deleteProvider(env, 'missing');
	});
});

describe('_assertValidEndpoint', () => {
	it('accepts public https URLs', () => {
		expect(() => _assertValidEndpoint('https://api.example.com/v1')).not.toThrow();
	});

	it('rejects non-https schemes', () => {
		expect(() => _assertValidEndpoint('http://api.example.com/v1')).toThrow(/https/i);
		expect(() => _assertValidEndpoint('ftp://api.example.com/v1')).toThrow(/https/i);
	});

	it('rejects unparseable URLs', () => {
		expect(() => _assertValidEndpoint('not a url')).toThrow();
	});

	it('rejects loopback and RFC 1918 IPv4 literals', () => {
		expect(() => _assertValidEndpoint('https://127.0.0.1/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://10.0.0.1/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://192.168.1.1/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://172.16.0.1/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://169.254.169.254/v1')).toThrow();
	});

	it('rejects localhost and localhost.localdomain', () => {
		expect(() => _assertValidEndpoint('https://localhost/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://localhost.localdomain/v1')).toThrow();
	});

	// Regression: the previous implementation only ran its private-address
	// check when the host was `localhost` or an IPv4 literal, so an operator
	// who entered `https://[::1]:8443/v1` bypassed the guard and the OpenAI
	// SDK would ship the configured `Authorization: Bearer <apiKey>` to the
	// loopback interface. The consolidated guard now uses the same shared
	// `assertPublicHttpsUrl` predicate the MCP path uses, which covers IPv6.
	it('rejects IPv6 loopback and ULA literals', () => {
		expect(() => _assertValidEndpoint('https://[::1]/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://[fc00::1]/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://[fd00::1]/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://[fe80::1]/v1')).toThrow();
	});

	// Regression: IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the dual-stack
	// representation of an IPv4 address; the WHATWG URL parser normalises
	// `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, which the bare IPv6 prefix
	// checks miss entirely.
	it('rejects IPv4-mapped IPv6 private literals', () => {
		expect(() => _assertValidEndpoint('https://[::ffff:127.0.0.1]/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://[::ffff:169.254.169.254]/v1')).toThrow();
		expect(() => _assertValidEndpoint('https://[::ffff:10.0.0.1]/v1')).toThrow();
	});

	// Regression: an endpoint with userinfo (`https://user:pass@host/v1`) was
	// previously accepted; the shared guard now rejects it so a malicious
	// endpoint string can't smuggle credentials past the URL parser.
	it('rejects URLs that embed userinfo credentials', () => {
		expect(() => _assertValidEndpoint('https://user:pass@api.example.com/v1')).toThrow();
	});
});
