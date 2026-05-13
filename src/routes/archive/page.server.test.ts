import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveConversation, createConversation } from '$lib/server/conversations';
import { load } from './+page.server';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

type LoadEvent = Parameters<typeof load>[0];

function makeEvent(opts: { platform?: unknown } = {}): LoadEvent {
	return {
		platform: 'platform' in opts ? opts.platform : { env },
	} as unknown as LoadEvent;
}

async function expectError(promise: Promise<unknown>, status: number): Promise<void> {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
	}
}

async function loadOk(event: LoadEvent): Promise<Record<string, unknown>> {
	const result = await load(event);
	if (!result) throw new Error('load returned void');

	return result as Record<string, unknown>;
}

describe('archive/+page.server.ts — load', () => {
	it('returns 500 when platform is missing', async () => {
		await expectError(Promise.resolve(load(makeEvent({ platform: undefined }))), 500);
	});

	it('returns an empty list initially', async () => {
		const data = await loadOk(makeEvent());
		expect(data.archived).toEqual([]);
	});

	it('returns archived conversations after archiveConversation is called', async () => {
		const id = await createConversation(env);
		await archiveConversation(env, id);
		const data = await loadOk(makeEvent());
		expect((data.archived as Array<{ id: string }>).map((c) => c.id)).toEqual([id]);
	});

	it('does not include unarchived conversations', async () => {
		const a = await createConversation(env);
		const b = await createConversation(env);
		await archiveConversation(env, a);
		const data = await loadOk(makeEvent());
		const archived = data.archived as Array<{ id: string }>;
		expect(archived.map((c) => c.id)).toEqual([a]);
		expect(archived.find((c) => c.id === b)).toBeUndefined();
	});
});
