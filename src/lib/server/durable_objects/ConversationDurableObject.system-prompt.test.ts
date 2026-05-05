import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import { textTurn } from '../../../../test/fakes/FakeLLM';
import { readLLMCalls, setOverride, stubFor, waitForState } from './conversation/_test-helpers';
import type { ConversationStub } from './index';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
	await env.DB.prepare('DELETE FROM settings').run();
	await env.DB.prepare('DELETE FROM memories').run();
	await env.DB.prepare('DELETE FROM styles').run();
});

async function captureSystemPrompt(stub: ConversationStub): Promise<string> {
	const calls = await readLLMCalls(stub);
	expect(calls.length).toBeGreaterThan(0);
	return calls[0].systemPrompt ?? '';
}

describe('ConversationDurableObject — system prompt assembly', () => {
	it('uses the global system prompt setting when no override is set', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await env.DB.prepare(
			`INSERT OR REPLACE INTO settings (user_id, key, value, updated_at) VALUES (1, 'system_prompt', 'GLOBAL_PROMPT', 1)`,
		).run();
		await setOverride(stub, [textTurn('ok').events]);
		await stub.addUserMessage(id, 'hi', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');
		const sp = await captureSystemPrompt(stub);
		expect(sp).toContain('GLOBAL_PROMPT');
	});

	it('per-conversation override replaces the global setting', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await env.DB.prepare(
			`INSERT OR REPLACE INTO settings (user_id, key, value, updated_at) VALUES (1, 'system_prompt', 'GLOBAL_PROMPT', 1)`,
		).run();
		await stub.setSystemPrompt(id, 'OVERRIDE_PROMPT');
		await setOverride(stub, [textTurn('ok').events]);
		await stub.addUserMessage(id, 'hi', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');
		const sp = await captureSystemPrompt(stub);
		expect(sp).toContain('OVERRIDE_PROMPT');
		expect(sp).not.toContain('GLOBAL_PROMPT');
	});

	it('selected style is prepended to the (possibly overridden) base prompt', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const styleResult = await env.DB.prepare(
			`INSERT INTO styles (user_id, name, system_prompt, created_at, updated_at)
			 VALUES (1, 'Concise', 'STYLE_TEXT', 1, 1) RETURNING id`,
		).first<{ id: number }>();
		await stub.setStyle(id, styleResult!.id);
		await stub.setSystemPrompt(id, 'BASE_OVERRIDE');
		await setOverride(stub, [textTurn('ok').events]);
		await stub.addUserMessage(id, 'hi', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');
		const sp = await captureSystemPrompt(stub);
		expect(sp.indexOf('STYLE_TEXT')).toBeLessThan(sp.indexOf('BASE_OVERRIDE'));
	});

	it('memories are appended as a Memories block', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await env.DB.prepare(
			`INSERT INTO memories (user_id, type, content, source, created_at) VALUES
				(1, 'manual', 'My dog is Pepper.', 'user', 100),
				(1, 'auto', 'I work in TypeScript.', 'tool:remember', 200)`,
		).run();
		await setOverride(stub, [textTurn('ok').events]);
		await stub.addUserMessage(id, 'hi', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');
		const sp = await captureSystemPrompt(stub);
		expect(sp).toMatch(/Memories/);
		expect(sp).toContain('My dog is Pepper.');
		expect(sp).toContain('I work in TypeScript.');
	});

	it('user_bio is appended', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await env.DB.prepare(
			`INSERT OR REPLACE INTO settings (user_id, key, value, updated_at) VALUES (1, 'user_bio', 'BIO_TEXT', 1)`,
		).run();
		await setOverride(stub, [textTurn('ok').events]);
		await stub.addUserMessage(id, 'hi', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');
		const sp = await captureSystemPrompt(stub);
		expect(sp).toContain('User bio:');
		expect(sp).toContain('BIO_TEXT');
	});

	it('falls back to the default prompt when nothing is configured', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await setOverride(stub, [textTurn('ok').events]);
		await stub.addUserMessage(id, 'hi', 'fake/model');
		await waitForState(stub, (s) => s.messages.at(-1)?.status === 'complete');
		const sp = await captureSystemPrompt(stub);
		// Default prompt mentions being a computer and being concise.
		expect(sp.length).toBeGreaterThan(100);
	});
});
