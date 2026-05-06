import { env } from 'cloudflare:test';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import * as remote from './sandbox.remote';
import { createConversation } from './server/conversations';

type AnyArgs = (...args: unknown[]) => Promise<unknown>;
const getSandboxPreviewPorts = remote.getSandboxPreviewPorts as unknown as AnyArgs;

beforeEach(() => {
	setMockRequestEvent({ platform: { env } });
});

afterEach(async () => {
	clearMockRequestEvent();
	await env.DB.prepare('DELETE FROM conversations').run();
});

async function expectError(promise: Promise<unknown>, status: number) {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
	}
}

describe('sandbox.remote — getSandboxPreviewPorts', () => {
	it('returns an empty list for a fresh conversation (no sandbox booted)', async () => {
		const id = await createConversation(env);
		const result = (await getSandboxPreviewPorts(id)) as { ports: unknown[] };
		expect(result).toEqual({ ports: [] });
	});

	it('rejects malformed conversation ids with 400', async () => {
		await expectError(getSandboxPreviewPorts('not-a-uuid') as Promise<unknown>, 400);
	});
});
