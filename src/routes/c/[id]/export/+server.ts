import { error } from '@sveltejs/kit';
import { getConversation } from '$lib/server/conversations';
import { getConversationStub } from '$lib/server/durable_objects';
import { CONVERSATION_ID_PATTERN } from '$lib/conversation-id';
import type { ConversationState, MessagePart, MessageRow } from '$lib/types/conversation';
import type { RequestHandler } from './$types';

function safeFilename(s: string): string {
	const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
	return cleaned || 'conversation';
}

function partToMarkdown(p: MessagePart): string {
	switch (p.type) {
		case 'text':
			return p.text;
		case 'thinking':
			return `> _thinking_\n>\n` + p.text.split('\n').map((l) => `> ${l}`).join('\n');
		case 'tool_use':
			return [
				`<details><summary>tool call: <code>${p.name}</code></summary>`,
				'',
				'```json',
				JSON.stringify(p.input ?? null, null, 2),
				'```',
				'</details>',
			].join('\n');
		case 'tool_result':
			return [
				`<details><summary>tool result${p.isError ? ' (error)' : ''}</summary>`,
				'',
				'```',
				p.content,
				'```',
				'</details>',
			].join('\n');
		case 'info':
			return `_${p.text}_`;
	}
}

function messageToMarkdown(m: MessageRow): string {
	const heading = `### ${m.role}${m.model ? ` · ${m.model}` : ''} — ${new Date(m.createdAt).toISOString()}`;
	const body =
		m.parts && m.parts.length > 0
			? m.parts.map(partToMarkdown).filter(Boolean).join('\n\n')
			: m.content || '_(empty)_';
	const artifacts =
		m.artifacts && m.artifacts.length > 0
			? '\n\n' +
				m.artifacts
					.map(
					(a) =>
						`#### Artifact: ${a.name ?? a.type}${a.language ? ` (${a.language})` : ''} — v${a.version}\n\n` +
						(a.type === 'code'
							? '```' + (a.language ?? '') + '\n' + a.content + '\n```'
							: a.type === 'html' || a.type === 'svg'
								? '```html\n' + a.content + '\n```'
								: a.content),
					)
					.join('\n\n')
			: '';
	const err = m.status === 'error' && m.error ? `\n\n> **Error:** ${m.error}` : '';
	return `${heading}\n\n${body}${artifacts}${err}`;
}

export const GET: RequestHandler = async ({ params, url, platform }) => {
	if (!platform) error(500, 'Cloudflare platform bindings unavailable');
	const conversationId = params.id;
	if (!CONVERSATION_ID_PATTERN.test(conversationId)) error(404, 'not found');

	const stub = getConversationStub(platform.env, conversationId);
	const conversation = await getConversation(platform.env, conversationId);
	if (!conversation) error(404, 'not found');
	const state = (await stub.getState()) as ConversationState;

	const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
	const baseName = safeFilename(conversation.title);

	if (format === 'json') {
		const payload = {
			id: conversation.id,
			title: conversation.title,
			created_at: conversation.created_at,
			updated_at: conversation.updated_at,
			messages: state.messages.map((m) => ({
				id: m.id,
				role: m.role,
				model: m.model,
				createdAt: m.createdAt,
				content: m.content,
				thinking: m.thinking ?? null,
				parts: m.parts ?? null,
				artifacts:
					m.artifacts?.map((a) => ({
						id: a.id,
						type: a.type,
						name: a.name,
						version: a.version,
						language: a.language ?? null,
						content: a.content,
						createdAt: a.createdAt,
					})) ?? null,
				status: m.status,
				error: m.error,
				usage: m.meta?.usage ?? null,
			})),
		};
		return new Response(JSON.stringify(payload, null, 2), {
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Content-Disposition': `attachment; filename="${baseName}.json"`,
			},
		});
	}

	const md = [
		`# ${conversation.title}`,
		`_Exported ${new Date().toISOString()} · created ${new Date(conversation.created_at).toISOString()}_`,
		'',
		...state.messages.filter((m) => m.role !== 'system').map(messageToMarkdown),
	].join('\n\n');
	return new Response(md, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			'Content-Disposition': `attachment; filename="${baseName}.md"`,
		},
	});
};
