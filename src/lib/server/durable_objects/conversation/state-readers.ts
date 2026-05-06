import type { Artifact, ArtifactType, MessageRow, MessagePart, MetaSnapshot } from '$lib/types/conversation';
import { partsFromJson, type BlobEnv } from './blob-store';

export async function readMessages(sql: SqlStorage, env: BlobEnv): Promise<MessageRow[]> {
	const rows = sql
		.exec(
			`SELECT id, role, content, model, status, error, created_at, started_at, first_token_at, last_chunk_json, usage_json, thinking, parts
			 FROM messages
			 WHERE deleted_at IS NULL
			 ORDER BY created_at ASC`,
		)
		.toArray() as unknown as Array<{
		id: string;
		role: string;
		content: string;
		model: string | null;
		status: string;
		error: string | null;
		created_at: number;
		started_at: number | null;
		first_token_at: number | null;
		last_chunk_json: string | null;
		usage_json: string | null;
		thinking: string | null;
		parts: string | null;
	}>;
	const artifactsByMessage = readArtifactsByMessage(sql);
	return Promise.all(
		rows.map(async (r) => {
			const parts = stripHtml((await partsFromJson(r.parts, env)) ?? []);
			return {
				id: r.id,
				role: r.role as 'user' | 'assistant',
				content: r.content,
				thinking: r.thinking,
				model: r.model,
				status: r.status as 'complete' | 'streaming' | 'error',
				error: r.error,
				createdAt: r.created_at,
				meta: deriveMeta(r.started_at, r.first_token_at, r.last_chunk_json, r.usage_json),
				artifacts: artifactsByMessage.get(r.id) ?? [],
				parts,
			};
		}),
	);
}

// Legacy rows persisted server-rendered HTML inside parts. Strip it on read so
// the wire format never carries pre-rendered markup; the client re-renders.
function stripHtml(parts: MessagePart[]): MessagePart[] {
	return parts.map((p) => {
		if (p.type === 'text' || p.type === 'thinking') {
			if ('textHtml' in p) {
				const { textHtml: _ignored, ...rest } = p as { textHtml?: string } & MessagePart;
				return rest as MessagePart;
			}
			return p;
		}
		if (p.type === 'tool_use' && 'inputHtml' in p) {
			const { inputHtml: _ignored, ...rest } = p as { inputHtml?: string } & MessagePart;
			return rest as MessagePart;
		}
		return p;
	});
}

export function readArtifactsByMessage(sql: SqlStorage): Map<string, Artifact[]> {
	const rows = sql
		.exec(
			`SELECT id, message_id, type, name, language, version, content, created_at FROM artifacts ORDER BY created_at ASC`,
		)
		.toArray() as unknown as Array<{
		id: string;
		message_id: string;
		type: string;
		name: string | null;
		language: string | null;
		version: number;
		content: string;
		created_at: number;
	}>;
	const map = new Map<string, Artifact[]>();
	for (const r of rows) {
		const list = map.get(r.message_id) ?? [];
		list.push({
			id: r.id,
			messageId: r.message_id,
			type: r.type as ArtifactType,
			name: r.name,
			language: r.language,
			version: r.version,
			content: r.content,
			createdAt: r.created_at,
		});
		map.set(r.message_id, list);
	}
	return map;
}

export function deriveMeta(
	startedAt: number | null,
	firstTokenAt: number | null,
	lastChunkJson: string | null,
	usageJson: string | null,
): MetaSnapshot | null {
	if (!startedAt && !lastChunkJson && !usageJson) return null;
	let lastChunk: unknown | null = null;
	let usage: MetaSnapshot['usage'] = null;
	try {
		if (lastChunkJson) lastChunk = JSON.parse(lastChunkJson) as unknown;
	} catch {
		/* keep null */
	}
	try {
		if (usageJson) usage = JSON.parse(usageJson) as MetaSnapshot['usage'];
	} catch {
		/* keep null */
	}
	return {
		startedAt: startedAt ?? 0,
		firstTokenAt: firstTokenAt ?? 0,
		lastChunk,
		usage,
	};
}
