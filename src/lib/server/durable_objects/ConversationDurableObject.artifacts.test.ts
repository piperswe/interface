import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createConversation } from '../conversations';
import { readState, stubFor } from './conversation/_test-helpers';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM conversations').run();
});

describe('ConversationDurableObject — artifacts & sandbox', () => {
	it('addArtifact persists a code artifact and bumps versions', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', 'see code', 'm', 'complete', 1)",
			);
		});

		const a1 = await stub.addArtifact({ messageId: 'a1', type: 'code', language: 'typescript', name: 'index.ts', content: 'const x = 1;' });
		const a2 = await stub.addArtifact({ messageId: 'a1', type: 'code', language: 'typescript', name: 'index.ts', content: 'const x = 2;' });

		expect(a1.version).toBe(1);
		expect(a2.version).toBe(2);
		expect(a1.id).not.toBe(a2.id);

		const state = await readState(stub);
		const m = state.messages.find((mm) => mm.id === 'a1');
		expect(m?.artifacts).toHaveLength(2);
		expect(m?.artifacts?.map((a) => a.version)).toEqual([1, 2]);
	});

	it('artifacts table has the expanded schema', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			const cols = ctx.storage.sql
				.exec('PRAGMA table_info(artifacts)')
				.toArray() as unknown as Array<{ name: string }>;
			const names = cols.map((c) => c.name);
			expect(names).toEqual(
				expect.arrayContaining(['id', 'message_id', 'type', 'name', 'language', 'version', 'content', 'created_at']),
			);
		});
	});

	it('addArtifact supports html, svg, and mermaid types', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		await runInDurableObject(stub, async (_instance, ctx) => {
			ctx.storage.sql.exec(
				"INSERT INTO messages (id, role, content, model, status, created_at) VALUES ('a1', 'assistant', 'see artifact', 'm', 'complete', 1)",
			);
		});

		const html = await stub.addArtifact({ messageId: 'a1', type: 'html', name: 'page.html', content: '<h1>Hello</h1>' });
		const svg = await stub.addArtifact({ messageId: 'a1', type: 'svg', name: 'icon.svg', content: '<svg><circle r="5"/></svg>' });
		const mermaid = await stub.addArtifact({ messageId: 'a1', type: 'mermaid', name: 'diagram', content: 'graph TD; A-->B;' });

		expect(html.type).toBe('html');
		expect(html.contentHtml).toBeNull();
		expect(svg.type).toBe('svg');
		expect(svg.contentHtml).toBe(svg.content);
		expect(mermaid.type).toBe('mermaid');
		expect(mermaid.contentHtml).toBeNull();

		const state = await readState(stub);
		const m = state.messages.find((mm) => mm.id === 'a1');
		expect(m?.artifacts).toHaveLength(3);
	});

	it('getSandboxPreviewPorts returns an empty array gracefully when sandbox is unavailable', async () => {
		const id = await createConversation(env);
		const stub = stubFor(id);
		const ports = await stub.getSandboxPreviewPorts();
		expect(Array.isArray(ports)).toBe(true);
	});
});
