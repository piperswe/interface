import { env } from 'cloudflare:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMockRequestEvent, setMockRequestEvent } from '../../test/shims/app-server';
import * as remote from './conversations.remote';

// The remote functions are typed as opaque `RemoteForm`/`RemoteCommand`s by
// SvelteKit. Under the test alias for `$app/server` they're plain callables
// (see test/shims/app-server.ts), so we cast through `unknown` once.
type AnyArgs = (...args: unknown[]) => Promise<unknown>;
const archive = remote.archive as unknown as AnyArgs;
const createNewConversation = remote.createNewConversation as unknown as AnyArgs;
const destroyConv = remote.destroy as unknown as AnyArgs;
const regenerateTitle = remote.regenerateTitle as unknown as AnyArgs;
const sendMessage = remote.sendMessage as unknown as AnyArgs;
const setThinkingBudget = remote.setThinkingBudget as unknown as AnyArgs;
const setConversationSystemPrompt = remote.setConversationSystemPrompt as unknown as AnyArgs;
const setConversationStyle = remote.setConversationStyle as unknown as AnyArgs;
const unarchive = remote.unarchive as unknown as AnyArgs;
import {
	createConversation,
	getConversation,
	listArchivedConversations,
	listConversations,
} from './server/conversations';

beforeEach(() => {
	setMockRequestEvent({ platform: { env } });
});

afterEach(async () => {
	clearMockRequestEvent();
	await env.DB.prepare('DELETE FROM conversations').run();
});

async function expectRedirect(promise: Promise<unknown>, locationStartsWith: string) {
	try {
		await promise;
		throw new Error('expected redirect');
	} catch (e) {
		if (!isRedirect(e)) throw e;
		expect(e.location.startsWith(locationStartsWith)).toBe(true);
	}
}

async function expectError(promise: Promise<unknown>, status: number, msg?: RegExp) {
	try {
		await promise;
		throw new Error('expected error');
	} catch (e) {
		if (!isHttpError(e)) throw e;
		expect(e.status).toBe(status);
		if (msg) expect(String(e.body.message)).toMatch(msg);
	}
}

describe('createNewConversation', () => {
	it('creates a row and returns the new id', async () => {
		const result = (await createNewConversation()) as { id: string };
		expect(typeof result.id).toBe('string');
		const list = await listConversations(env);
		expect(list.map((r) => r.id)).toEqual([result.id]);
	});
});

describe('archive / unarchive', () => {
	it('archive moves the conversation out of the active list', async () => {
		const id = await createConversation(env);
		await expectRedirect(archive({ conversationId: id }) as Promise<unknown>, '/');
		expect(await listConversations(env)).toEqual([]);
		const archived = await listArchivedConversations(env);
		expect(archived.map((r) => r.id)).toEqual([id]);
	});

	it('archive respects an explicit redirectTo', async () => {
		const id = await createConversation(env);
		await expectRedirect(
			archive({ conversationId: id, redirectTo: '/archive' }) as Promise<unknown>,
			'/archive',
		);
		expect(await listConversations(env)).toEqual([]);
	});

	it('unarchive restores the conversation', async () => {
		const id = await createConversation(env);
		await expectRedirect(archive({ conversationId: id }) as Promise<unknown>, '/');
		await expectRedirect(unarchive({ conversationId: id }) as Promise<unknown>, `/c/${id}`);
		expect((await listConversations(env)).map((r) => r.id)).toEqual([id]);
	});

	it('archive rejects malformed ids', async () => {
		await expectError(archive({ conversationId: 'not-a-uuid' }) as Promise<unknown>, 400, /invalid/i);
	});

	it('unarchive rejects malformed ids', async () => {
		await expectError(unarchive({ conversationId: 'bad' }) as Promise<unknown>, 400, /invalid/i);
	});
});

describe('destroy', () => {
	it('drops the row and wipes the DO storage', async () => {
		const id = await createConversation(env);
		await expectRedirect(destroyConv({ conversationId: id }) as Promise<unknown>, '/');
		expect(await getConversation(env, id)).toBeNull();
	});

	it('rejects malformed ids', async () => {
		await expectError(destroyConv({ conversationId: 'nope' }) as Promise<unknown>, 400);
	});
});

describe('sendMessage', () => {
	it('rejects empty content', async () => {
		const id = await createConversation(env);
		await expectError(
			sendMessage({ conversationId: id, content: '   ', model: 'm/test' }) as Promise<unknown>,
			400,
			/empty/,
		);
	});

	it('rejects missing model', async () => {
		const id = await createConversation(env);
		await expectError(
			sendMessage({ conversationId: id, content: 'hi', model: '' }) as Promise<unknown>,
			400,
			/missing model/,
		);
	});

	it('rejects malformed conversation ids', async () => {
		await expectError(
			sendMessage({ conversationId: 'bad', content: 'hi', model: 'm/test' }) as Promise<unknown>,
			400,
		);
	});
});

describe('regenerateTitle', () => {
	it('rejects malformed ids', async () => {
		await expectError(regenerateTitle('bad-id') as Promise<unknown>, 400);
	});
});

describe('setThinkingBudget', () => {
	it('persists the budget on the conversation row', async () => {
		const id = await createConversation(env);
		await setThinkingBudget({ conversationId: id, budget: 4096 });
		const row = await getConversation(env, id);
		expect(row?.thinking_budget).toBe(4096);
	});

	it('clears the budget when null is passed', async () => {
		const id = await createConversation(env);
		await setThinkingBudget({ conversationId: id, budget: 4096 });
		await setThinkingBudget({ conversationId: id, budget: null });
		const row = await getConversation(env, id);
		expect(row?.thinking_budget).toBeNull();
	});

	it('rejects malformed ids', async () => {
		await expectError(
			setThinkingBudget({ conversationId: 'bad', budget: 1 }) as Promise<unknown>,
			400,
		);
	});
});

describe('setConversationSystemPrompt', () => {
	it('persists a non-empty override', async () => {
		const id = await createConversation(env);
		await setConversationSystemPrompt({ conversationId: id, prompt: 'be terse' });
		const row = await getConversation(env, id);
		expect(row?.system_prompt).toBe('be terse');
	});

	it('null clears the override', async () => {
		const id = await createConversation(env);
		await setConversationSystemPrompt({ conversationId: id, prompt: 'override' });
		await setConversationSystemPrompt({ conversationId: id, prompt: null });
		const row = await getConversation(env, id);
		expect(row?.system_prompt).toBeNull();
	});

	it('rejects malformed ids', async () => {
		await expectError(
			setConversationSystemPrompt({ conversationId: 'bad', prompt: 'x' }) as Promise<unknown>,
			400,
		);
	});
});

describe('setConversationStyle', () => {
	it('persists a positive style id', async () => {
		const id = await createConversation(env);
		await setConversationStyle({ conversationId: id, styleId: 7 });
		const row = await getConversation(env, id);
		expect(row?.style_id).toBe(7);
	});

	it('null clears the style', async () => {
		const id = await createConversation(env);
		await setConversationStyle({ conversationId: id, styleId: 5 });
		await setConversationStyle({ conversationId: id, styleId: null });
		const row = await getConversation(env, id);
		expect(row?.style_id).toBeNull();
	});

	it('rejects malformed ids', async () => {
		await expectError(
			setConversationStyle({ conversationId: 'bad', styleId: 1 }) as Promise<unknown>,
			400,
		);
	});
});

describe('platform guard', () => {
	it('returns a 500 when the platform binding is missing', async () => {
		setMockRequestEvent({}); // no platform
		await expectError(createNewConversation() as Promise<unknown>, 500, /platform/i);
	});
});
