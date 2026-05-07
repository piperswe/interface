import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { runInDurableObject } from 'cloudflare:test';
import { expectError } from '../../../../../test/helpers';
import { GET } from './+server';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

async function callExport(conversationId: string, format?: string): Promise<Response> {
	const url = new URL(
		`http://localhost/c/${conversationId}/export${format ? `?format=${format}` : ''}`,
	);
	// Build the minimal RequestEvent shape the handler reads.
	const event = {
		params: { id: conversationId },
		url,
		platform: { env },
		request: new Request(url.toString()),
	} as Parameters<typeof GET>[0];
	return GET(event);
}

async function seedConversation(): Promise<string> {
	const id = await createConversation(env);
	const stub = getConversationStub(env, id);
	await runInDurableObject(stub, async (_instance, ctx) => {
		ctx.storage.sql.exec(
			"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('s1', 'system', 'sys ctx', NULL, 'complete', 1000)",
		);
		ctx.storage.sql.exec(
			"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('u1', 'user', 'hello', NULL, 'complete', 1001)",
		);
		const parts = JSON.stringify([
			{ type: 'text', text: 'hi back' },
			{ type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'x' } },
			{ type: 'tool_result', toolUseId: 't1', content: 'result body', isError: false },
		]);
		ctx.storage.sql.exec(
			`INSERT INTO messages (id, role, content, model, status, created_at, parts)
			 VALUES ('a1', 'assistant', 'hi back', 'm/test', 'complete', 1002, ?)`,
			parts,
		);
	});
	// Give the conversation a friendly title so we can assert on the filename.
	await env.DB.prepare("UPDATE conversations SET title = 'My chat' WHERE id = ?").bind(id).run();
	return id;
}

describe('conversation export endpoint', () => {
	it('rejects invalid conversation ids with 404', async () => {
		await expectError(callExport('not-a-uuid'), 404);
	});

	it('returns 404 for a nonexistent conversation row', async () => {
		// Build a syntactically valid id but never insert it.
		await expectError(callExport('00000000-0000-0000-0000-000000000000'), 404);
	});

	it('defaults to markdown format', async () => {
		const id = await seedConversation();
		const res = await callExport(id);
		expect(res.headers.get('Content-Type')).toMatch(/text\/markdown/);
		expect(res.headers.get('Content-Disposition')).toMatch(/\.md"$/);
	});

	it('includes title, user message, assistant text, tool call + result in markdown', async () => {
		const id = await seedConversation();
		const res = await callExport(id, 'md');
		const body = await res.text();
		expect(body).toContain('# My chat');
		expect(body).toContain('hello');
		expect(body).toContain('hi back');
		expect(body).toContain('web_search');
		expect(body).toContain('result body');
		// System messages are filtered out.
		expect(body).not.toContain('sys ctx');
	});

	it('json export round-trips through JSON.parse with full message structure', async () => {
		const id = await seedConversation();
		const res = await callExport(id, 'json');
		expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
		const parsed = JSON.parse(await res.text()) as {
			id: string;
			title: string;
			messages: Array<{ id: string; role: string; parts?: unknown[] | null }>;
		};
		expect(parsed.id).toBe(id);
		expect(parsed.title).toBe('My chat');
		const ids = parsed.messages.map((m) => m.id);
		expect(ids).toEqual(['s1', 'u1', 'a1']);
		const a1 = parsed.messages.find((m) => m.id === 'a1');
		expect(a1?.parts).toHaveLength(3);
	});

	it('uses a sanitized filename in Content-Disposition', async () => {
		const id = await createConversation(env);
		await env.DB.prepare("UPDATE conversations SET title = 'evil/title with spaces!' WHERE id = ?")
			.bind(id)
			.run();
		const res = await callExport(id, 'md');
		const cd = res.headers.get('Content-Disposition') ?? '';
		expect(cd).toMatch(/filename="evil_title_with_spaces_?\.md"/);
	});
});
