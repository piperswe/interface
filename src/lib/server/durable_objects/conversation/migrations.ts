// Versioned schema migrations for the Conversation Durable Object's
// per-DO SQLite store. Append-only — never edit a published entry.
// Migration 1 is the legacy CREATE+ALTER bundle; all DOs that pre-date
// the `_meta` table will pass through it on first boot, but each ALTER
// swallows "column exists" errors so it's safe.

// Idempotent helper: run ALTER, swallow "duplicate column" errors so the same
// migration can be safely replayed on a DO that pre-dates the schema
// versioning table.
function alterIgnoreExists(sql: SqlStorage, stmt: string): void {
	try {
		sql.exec(stmt);
	} catch {
		// column already exists
	}
}

const MIGRATIONS: { version: number; up: (sql: SqlStorage) => void }[] = [
	{
		version: 1,
		up: (sql) => {
			sql.exec(`
				CREATE TABLE IF NOT EXISTS messages (
					id TEXT PRIMARY KEY,
					role TEXT NOT NULL,
					content TEXT NOT NULL,
					model TEXT,
					status TEXT NOT NULL,
					error TEXT,
					created_at INTEGER NOT NULL,
					started_at INTEGER,
					first_token_at INTEGER,
					last_chunk_json TEXT,
					usage_json TEXT,
					generation_json TEXT,
					provider TEXT,
					thinking TEXT,
					tool_calls TEXT,
					tool_results TEXT,
					parent_id TEXT,
					deleted_at INTEGER,
					artifact_ids TEXT,
					parts TEXT
				)
			`);
			sql.exec(`
				CREATE TABLE IF NOT EXISTS artifacts (
					id TEXT PRIMARY KEY,
					message_id TEXT NOT NULL,
					type TEXT NOT NULL,
					name TEXT,
					language TEXT,
					version INTEGER NOT NULL DEFAULT 1,
					content TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`);
			alterIgnoreExists(sql, 'ALTER TABLE artifacts ADD COLUMN language TEXT');
			sql.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id)');
			for (const stmt of [
				'ALTER TABLE messages ADD COLUMN started_at INTEGER',
				'ALTER TABLE messages ADD COLUMN first_token_at INTEGER',
				'ALTER TABLE messages ADD COLUMN last_chunk_json TEXT',
				'ALTER TABLE messages ADD COLUMN usage_json TEXT',
				'ALTER TABLE messages ADD COLUMN generation_json TEXT',
				'ALTER TABLE messages ADD COLUMN provider TEXT',
				'ALTER TABLE messages ADD COLUMN thinking TEXT',
				'ALTER TABLE messages ADD COLUMN tool_calls TEXT',
				'ALTER TABLE messages ADD COLUMN tool_results TEXT',
				'ALTER TABLE messages ADD COLUMN parent_id TEXT',
				'ALTER TABLE messages ADD COLUMN deleted_at INTEGER',
				'ALTER TABLE messages ADD COLUMN artifact_ids TEXT',
				'ALTER TABLE messages ADD COLUMN parts TEXT',
			]) {
				alterIgnoreExists(sql, stmt);
			}
		},
	},
	{
		version: 2,
		up: (sql) => {
			// Server-rendered HTML cached alongside the raw content, so page
			// loads don't have to re-run marked + Shiki + KaTeX. Populated at
			// generation completion; null for legacy rows (the SSR path falls
			// back to live rendering when missing).
			alterIgnoreExists(sql, 'ALTER TABLE messages ADD COLUMN content_html TEXT');
			alterIgnoreExists(sql, 'ALTER TABLE messages ADD COLUMN thinking_html TEXT');
			alterIgnoreExists(sql, 'ALTER TABLE messages ADD COLUMN parts_html TEXT');
			alterIgnoreExists(sql, 'ALTER TABLE artifacts ADD COLUMN content_html TEXT');
		},
	},
	{
		version: 3,
		up: (sql) => {
			// Guard every step against already-dropped columns so this migration
			// is safe to re-run if it previously completed the DROPs but crashed
			// before the schema_version write (which would leave the DO stuck
			// retrying the migration forever on each cold start).
			const existingCols = new Set(
				(sql.exec('PRAGMA table_info(messages)').toArray() as unknown as Array<{ name: string }>).map(
					(c) => c.name,
				),
			);

			// Backfill `parts` from any row that still has only the legacy
			// tool_calls/tool_results/thinking columns set, using the same
			// shape `buildLegacyParts` constructs at read time. Rows that
			// already have a `parts` JSON keep it.
			//
			// `parts_html` is folded into `parts` (the enriched parts JSON
			// has `textHtml` baked into text/thinking entries; readers tolerate
			// either shape). For rows where `parts_html` is set but `parts` is
			// not, copy across.
			//
			// Then drop the redundant columns. SQLite (3.35+) supports
			// `DROP COLUMN`; Cloudflare's DO SQLite is recent enough.
			if (existingCols.has('parts_html')) {
				sql.exec(
					`UPDATE messages SET parts = parts_html WHERE parts IS NULL AND parts_html IS NOT NULL`,
				);
			}
			// Backfill from legacy tool_calls/tool_results columns for rows
			// missing `parts` entirely. The JSON shape mirrors `buildLegacyParts`:
			// thinking → text → tool_use[] → tool_result[].
			if (existingCols.has('tool_calls') || existingCols.has('tool_results')) {
				const rows = sql
					.exec(
						`SELECT id, content, thinking, tool_calls, tool_results FROM messages
						 WHERE parts IS NULL AND (thinking IS NOT NULL OR tool_calls IS NOT NULL OR tool_results IS NOT NULL)`,
					)
					.toArray() as unknown as Array<{
					id: string;
					content: string;
					thinking: string | null;
					tool_calls: string | null;
					tool_results: string | null;
				}>;
				for (const r of rows) {
					const tcs: Array<{ id: string; name: string; input: unknown; thoughtSignature?: string }> = (() => {
						try {
							return r.tool_calls ? JSON.parse(r.tool_calls) : [];
						} catch {
							return [];
						}
					})();
					const trs: Array<{ toolUseId: string; content: string; isError: boolean }> = (() => {
						try {
							return r.tool_results ? JSON.parse(r.tool_results) : [];
						} catch {
							return [];
						}
					})();
					const built: Array<Record<string, unknown>> = [];
					if (r.thinking) built.push({ type: 'thinking', text: r.thinking });
					if (r.content) built.push({ type: 'text', text: r.content });
					for (const tc of tcs) built.push({ type: 'tool_use', ...tc });
					for (const tr of trs)
						built.push({ type: 'tool_result', toolUseId: tr.toolUseId, content: tr.content, isError: tr.isError });
					if (built.length > 0) {
						sql.exec('UPDATE messages SET parts = ? WHERE id = ?', JSON.stringify(built), r.id);
					}
				}
			}
			// Drop the redundant columns. `generation_json` was always-null
			// after the OpenRouter generation-stats removal.
			try { sql.exec('ALTER TABLE messages DROP COLUMN tool_calls'); } catch { /* not present */ }
			try { sql.exec('ALTER TABLE messages DROP COLUMN tool_results'); } catch { /* not present */ }
			try { sql.exec('ALTER TABLE messages DROP COLUMN parts_html'); } catch { /* not present */ }
			try { sql.exec('ALTER TABLE messages DROP COLUMN generation_json'); } catch { /* not present */ }
		},
	},
];

// Migrations are applied in order, once each, gated by the `_meta` table's
// `schema_version` row. Adding a migration:
//   1. Append a new entry to MIGRATIONS with the next version number.
//   2. Don't edit existing entries — DOs already at version N skip them.
//   3. The numeric version is the source of truth; the comments are just
//      for humans.
export function runMigrations(sql: SqlStorage): void {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS _meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);
	const row = sql.exec("SELECT value FROM _meta WHERE key = 'schema_version'").toArray() as unknown as Array<{ value: string }>;
	const current = row[0] ? Number.parseInt(row[0].value, 10) || 0 : 0;
	for (const m of MIGRATIONS) {
		if (m.version <= current) continue;
		m.up(sql);
		sql.exec(
			"INSERT INTO _meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			String(m.version),
		);
	}
}
