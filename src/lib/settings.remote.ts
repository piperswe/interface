import { form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { setSetting } from '$lib/server/settings';
import { createMcpServer, deleteMcpServer } from '$lib/server/mcp_servers';
import {
	createSubAgent,
	deleteSubAgent,
	isValidSubAgentName,
	setSubAgentEnabled,
	updateSubAgent,
} from '$lib/server/sub_agents';
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

export const editSubAgent = form(
	'unchecked',
	async (data: {
		id?: unknown;
		description?: unknown;
		system_prompt?: unknown;
		model?: unknown;
		max_iterations?: unknown;
		allowed_tools?: unknown;
	}) => {
		const id = Number.parseInt(String(data.id ?? ''), 10);
		if (!Number.isFinite(id) || id <= 0) error(400, 'Invalid id');
		const description = String(data.description ?? '').trim();
		const systemPrompt = String(data.system_prompt ?? '');
		const modelRaw = String(data.model ?? '').trim();
		const maxIterRaw = String(data.max_iterations ?? '').trim();
		const allowedToolsRaw = String(data.allowed_tools ?? '');

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
			await updateSubAgent(getEnv(), id, {
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
