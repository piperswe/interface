import { renderMarkdown, renderArtifactCode } from '../../markdown';
import { now as nowMs, uuid } from '../../clock';
import type { Artifact, ArtifactType } from '$lib/types/conversation';

export type AddArtifactInput = {
	messageId: string;
	type: ArtifactType;
	name?: string | null;
	language?: string | null;
	content: string;
};

export async function insertArtifact(sql: SqlStorage, input: AddArtifactInput): Promise<Artifact> {
	const id = uuid();
	const now = nowMs();
	const versionRow = sql
		.exec('SELECT MAX(version) AS v FROM artifacts WHERE message_id = ?', input.messageId)
		.toArray() as unknown as Array<{ v: number | null }>;
	const version = (versionRow[0]?.v ?? 0) + 1;
	// Pre-render to HTML once at insert so SSR doesn't re-tokenise on every load.
	let contentHtml: string | null = null;
	try {
		if (input.type === 'code') {
			contentHtml = await renderArtifactCode(input.content, input.language ?? 'text');
		} else if (input.type === 'markdown') {
			contentHtml = await renderMarkdown(input.content);
		} else if (input.type === 'svg') {
			contentHtml = input.content;
		}
		// html and mermaid are rendered client-side; leave contentHtml null.
	} catch {
		/* SSR will re-render on demand */
	}
	sql.exec(
		`INSERT INTO artifacts (id, message_id, type, name, language, version, content, content_html, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		input.messageId,
		input.type,
		input.name ?? null,
		input.language ?? null,
		version,
		input.content,
		contentHtml,
		now,
	);
	// Update artifact_ids on the parent message.
	const existing = sql.exec('SELECT artifact_ids FROM messages WHERE id = ?', input.messageId).toArray() as unknown as Array<{
		artifact_ids: string | null;
	}>;
	let ids: string[] = [];
	if (existing[0]?.artifact_ids) {
		try {
			ids = JSON.parse(existing[0].artifact_ids) as string[];
		} catch {
			ids = [];
		}
	}
	ids.push(id);
	sql.exec('UPDATE messages SET artifact_ids = ? WHERE id = ?', JSON.stringify(ids), input.messageId);

	return {
		id,
		messageId: input.messageId,
		type: input.type,
		name: input.name ?? null,
		language: input.language ?? null,
		version,
		content: input.content,
		contentHtml,
		createdAt: now,
	};
}
