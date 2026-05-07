import { form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { setSetting } from '$lib/server/settings';
import { isValidTtsVoice } from '$lib/server/tts';
import { createMcpServer, deleteMcpServer } from '$lib/server/mcp_servers';
import {
	createSubAgent,
	deleteSubAgent,
	isValidSubAgentName,
	setSubAgentEnabled,
} from '$lib/server/sub_agents';
import { createMemory, deleteMemory } from '$lib/server/memories';
import { createStyle, deleteStyle, updateStyle } from '$lib/server/styles';
import { getMcpPreset } from '$lib/server/mcp/presets';
import { invalidateThemeCache } from '../hooks.server';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

const ALLOWED_SETTING_KEYS = new Set([
	'theme',
	'context_compaction_threshold',
	'context_compaction_summary_tokens',
	'system_prompt',
	'user_bio',
	'default_model',
	'title_model',
	'kagi_cost_per_1000_searches',
	'tts_voice',
	'workspace_io_mode',
]);

type Theme = 'system' | 'light' | 'dark';
function isTheme(v: string): v is Theme {
	return v === 'system' || v === 'light' || v === 'dark';
}

type WorkspaceIoMode = 'snapshot' | 'rclone-mount';
function isWorkspaceIoMode(v: string): v is WorkspaceIoMode {
	return v === 'snapshot' || v === 'rclone-mount';
}

function isValidThreshold(v: string): boolean {
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n >= 0 && n <= 100;
}

function isValidSummaryTokens(v: string): boolean {
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n >= 256;
}

function isValidNonNegativeNumber(v: string): boolean {
	if (v === '') return true; // empty clears the override; helper resolves to default
	const n = Number.parseFloat(v);
	return Number.isFinite(n) && n >= 0;
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
		if (key === 'kagi_cost_per_1000_searches' && !isValidNonNegativeNumber(value)) {
			error(400, 'Kagi cost per 1000 searches must be a non-negative number');
		}
		if (key === 'tts_voice' && value !== '' && !isValidTtsVoice(value)) {
			error(400, `Invalid TTS voice: ${value}`);
		}
		if (key === 'workspace_io_mode' && !isWorkspaceIoMode(value)) {
			error(400, `Invalid workspace I/O mode: ${value}`);
		}
		await setSetting(getEnv(), key, value);
		if (key === 'theme') invalidateThemeCache();
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

function parseAllowedTools(raw: string): string[] | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const names = trimmed
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return names.length > 0 ? names : null;
}

export const addSubAgent = form(
	'unchecked',
	async (data: {
		name?: unknown;
		description?: unknown;
		system_prompt?: unknown;
		model?: unknown;
		max_iterations?: unknown;
		allowed_tools?: unknown;
	}) => {
		const name = String(data.name ?? '').trim();
		const description = String(data.description ?? '').trim();
		const systemPrompt = String(data.system_prompt ?? '');
		const modelRaw = String(data.model ?? '').trim();
		const maxIterRaw = String(data.max_iterations ?? '').trim();
		const allowedToolsRaw = String(data.allowed_tools ?? '');

		if (!name || !isValidSubAgentName(name)) {
			error(
				400,
				'Name must start with a letter and contain only lowercase letters, digits, underscores, or hyphens (max 64 chars).',
			);
		}
		if (!description) error(400, 'Description is required');
		if (!systemPrompt.trim()) error(400, 'System prompt is required');

		let maxIterations: number | null = null;
		if (maxIterRaw) {
			const n = Number.parseInt(maxIterRaw, 10);
			if (!Number.isFinite(n) || n < 1 || n > 50) {
				error(400, 'max_iterations must be an integer between 1 and 50');
			}
			maxIterations = n;
		}

		try {
			await createSubAgent(getEnv(), {
				name,
				description,
				systemPrompt,
				model: modelRaw || null,
				maxIterations,
				allowedTools: parseAllowedTools(allowedToolsRaw),
			});
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const removeSubAgent = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	await deleteSubAgent(getEnv(), id);
	redirect(303, '/settings');
});

export const toggleSubAgent = form(
	'unchecked',
	async (data: { id?: unknown; enabled?: unknown }) => {
		const id = Number.parseInt(String(data.id ?? ''), 10);
		if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
		const enabled = String(data.enabled ?? '') === 'true';
		await setSubAgentEnabled(getEnv(), id, enabled);
		redirect(303, '/settings');
	},
);

export const addMemory = form('unchecked', async (data: { content?: unknown }) => {
	const content = String(data.content ?? '').trim();
	if (!content) error(400, 'Memory content is required');
	try {
		await createMemory(getEnv(), { type: 'manual', content, source: 'user' });
	} catch (e) {
		error(400, e instanceof Error ? e.message : String(e));
	}
	redirect(303, '/settings');
});

export const removeMemory = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	await deleteMemory(getEnv(), id);
	redirect(303, '/settings');
});

export const addStyle = form(
	'unchecked',
	async (data: { name?: unknown; system_prompt?: unknown }) => {
		const name = String(data.name ?? '').trim();
		const systemPrompt = String(data.system_prompt ?? '');
		if (!name) error(400, 'Name is required');
		if (!systemPrompt.trim()) error(400, 'System prompt is required');
		try {
			await createStyle(getEnv(), { name, systemPrompt });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const saveStyle = form(
	'unchecked',
	async (data: { id?: unknown; name?: unknown; system_prompt?: unknown }) => {
		const id = Number.parseInt(String(data.id ?? ''), 10);
		if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
		const name = String(data.name ?? '').trim();
		const systemPrompt = String(data.system_prompt ?? '');
		if (!name) error(400, 'Name is required');
		if (!systemPrompt.trim()) error(400, 'System prompt is required');
		try {
			await updateStyle(getEnv(), id, { name, systemPrompt });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const removeStyle = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	await deleteStyle(getEnv(), id);
	redirect(303, '/settings');
});

// Add an MCP server from the curated catalog. For OAuth-protected servers we
// create the row with `enabled = 0` and immediately redirect into the OAuth
// connect flow; for header-auth or no-auth servers we just create and return
// to settings.
export const addMcpFromPreset = form('unchecked', async (data: { preset_id?: unknown }) => {
	const presetId = String(data.preset_id ?? '');
	const preset = getMcpPreset(presetId);
	if (!preset) error(400, `Unknown MCP preset: ${presetId}`);
	const env = getEnv();
	const id = await createMcpServer(env, {
		name: preset.label,
		transport: preset.transport,
		url: preset.url,
		authJson: null,
	});
	if (preset.authMode === 'oauth') {
		// Disable until OAuth completes — the server's tools require a valid
		// access token.
		await env.DB.prepare('UPDATE mcp_servers SET enabled = 0 WHERE id = ?').bind(id).run();
		redirect(303, `/settings/mcp/${id}/connect`);
	}
	redirect(303, '/settings');
});

export const disconnectMcpServer = form('unchecked', async (data: { id?: unknown }) => {
	const id = Number.parseInt(String(data.id ?? ''), 10);
	if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
	const env = getEnv();
	await env.DB.prepare(
		`UPDATE mcp_servers SET
			oauth_access_token = NULL,
			oauth_refresh_token = NULL,
			oauth_expires_at = NULL,
			enabled = 0
		 WHERE id = ?`,
	)
		.bind(id)
		.run();
	redirect(303, '/settings');
});

