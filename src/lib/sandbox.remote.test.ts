import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import { type AnyArgs, expectError } from '../../test/helpers';
import * as remote from './sandbox.remote';
import { createConversation } from './server/conversations';

const getSandboxPreviewPorts = remote.getSandboxPreviewPorts as unknown as AnyArgs;

beforeEach(() => {
	setMockRequestEvent({ platform: { env }, url: new URL('http://test.example.com/') });
});

afterEach(async () => {
	clearMockRequestEvent();
	await env.DB.prepare('DELETE FROM conversations').run();
});

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
