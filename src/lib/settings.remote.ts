import { form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { setSetting } from '$lib/server/settings';
import { createMcpServer, deleteMcpServer } from '$lib/server/mcp_servers';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

const ALLOWED_SETTING_KEYS = new Set([
	'theme',
	'context_compaction_threshold',
	'context_compaction_summary_tokens',
	'model_list',
	'system_prompt',
	'user_bio',
]);

type Theme = 'system' | 'light' | 'dark';
function isTheme(v: string): v is Theme {
	return v === 'system' || v === 'light' || v === 'dark';
}

function isValidThreshold(v: string): boolean {
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n >= 0 && n <= 100;
}

function isValidSummaryTokens(v: string): boolean {
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n >= 256;
}

// Persist a single key/value setting (theme, system prompt, user bio,
// compaction params, model list). Re-uses the same key/value form across
// the Settings page; all validation lives here.
export const saveSetting = form(
	'unchecked',
	async (data: { key?: unknown; value?: unknown }) => {
		const key = String(data.key ?? '');
		const value = String(data.value ?? '');
		if (!ALLOWED_SETTING_KEYS.has(key)) error(400, `Unknown setting: ${key}`);
		if (key === 'theme' && !isTheme(value)) error(400, `Invalid theme: ${value}`);
		if (key === 'context_compaction_threshold' && !isValidThreshold(value)) {
			error(400, 'Threshold must be an integer between 0 and 100');
		}
		if (key === 'context_compaction_summary_tokens' && !isValidSummaryTokens(value)) {
			error(400, 'Summary budget must be at least 256 tokens');
		}
		await setSetting(getEnv(), key, value);
		redirect(303, '/settings');
	},
);

export const addMcpServer = form(
	'unchecked',
	async (data: { name?: unknown; transport?: unknown; url?: unknown; auth_json?: unknown }) => {
		const name = String(data.name ?? '').trim();
		const transportRaw = String(data.transport ?? '');
		const transport: 'http' | 'sse' | null =
			transportRaw === 'http' || transportRaw === 'sse' ? transportRaw : null;
		const urlField = String(data.url ?? '').trim();
		const authJson = String(data.auth_json ?? '').trim();
		if (!name || !transport || !urlField) {
			error(400, 'Missing required fields (name, transport, url)');
		}
		try {
			new URL(urlField);
		} catch {
			error(400, `Invalid URL: ${urlField}`);
		}
		if (authJson) {
			try {
				JSON.parse(authJson);
			} catch {
				error(400, 'auth_json must be valid JSON when provided');
			}
		}
		await createMcpServer(getEnv(), {
			name,
			transport,
			url: urlField,
			authJson: authJson || null,
		});
		redirect(303, '/settings');
	},
);

export const removeMcpServer = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	await deleteMcpServer(getEnv(), id);
	redirect(303, '/settings');
});
