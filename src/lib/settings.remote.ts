import { form, getRequestEvent } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
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
import { assertPublicHttpsUrl } from '$lib/server/url-guard';
import {
	positiveIntFromString,
	trimmedNonEmpty,
} from '$lib/server/remote-schemas';

function getEnv(): Env {
	const event = getRequestEvent();
	if (!event.platform) error(500, 'Cloudflare platform bindings unavailable');
	return event.platform.env;
}

const SETTING_KEYS = [
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
	'sandbox_backend',
] as const;

const SUB_AGENT_NAME_RULE =
	'Name must start with a letter and contain only lowercase letters, digits, underscores, or hyphens (max 64 chars).';

// Persist a single key/value setting (theme, system prompt, user bio,
// compaction params, model list). Re-uses the same key/value form across
// the Settings page; all per-key validation lives in the `superRefine`.
export const saveSetting = form(
	z
		.object({
			key: z.enum(SETTING_KEYS, {
				errorMap: (_issue, ctx) => ({ message: `Unknown setting: ${ctx.data}` }),
			}),
			value: z.string().default(''),
		})
		.superRefine((d, ctx) => {
			const issue = (message: string) =>
				ctx.addIssue({ code: 'custom', path: ['value'], message });
			switch (d.key) {
				case 'theme':
					if (d.value !== 'system' && d.value !== 'light' && d.value !== 'dark') {
						issue(`Invalid theme: ${d.value}`);
					}
					break;
				case 'context_compaction_threshold': {
					const n = Number.parseInt(d.value, 10);
					if (!Number.isFinite(n) || n < 0 || n > 100) {
						issue('Threshold must be an integer between 0 and 100');
					}
					break;
				}
				case 'context_compaction_summary_tokens': {
					const n = Number.parseInt(d.value, 10);
					if (!Number.isFinite(n) || n < 256) {
						issue('Summary budget must be at least 256 tokens');
					}
					break;
				}
				case 'kagi_cost_per_1000_searches':
					if (d.value !== '') {
						const n = Number.parseFloat(d.value);
						if (!Number.isFinite(n) || n < 0) {
							issue('Kagi cost per 1000 searches must be a non-negative number');
						}
					}
					break;
				case 'tts_voice':
					if (d.value !== '' && !isValidTtsVoice(d.value)) {
						issue(`Invalid TTS voice: ${d.value}`);
					}
					break;
				case 'workspace_io_mode':
					if (d.value !== 'snapshot' && d.value !== 'rclone-mount') {
						issue(`Invalid workspace I/O mode: ${d.value}`);
					}
					break;
				case 'sandbox_backend':
					if (d.value !== 'cloudflare' && d.value !== 'fly') {
						issue(`Invalid sandbox backend: ${d.value}`);
					}
					break;
			}
		}),
	async ({ key, value }) => {
		await setSetting(getEnv(), key, value);
		if (key === 'theme') invalidateThemeCache();
		redirect(303, '/settings');
	},
);

export const addMcpServer = form(
	z.object({
		name: trimmedNonEmpty('Missing required fields (name, transport, url)'),
		transport: z.enum(['http', 'sse'], {
			errorMap: () => ({ message: 'Missing required fields (name, transport, url)' }),
		}),
		url: trimmedNonEmpty('Missing required fields (name, transport, url)'),
		auth_json: z.string().optional().default(''),
	}),
	async ({ name, transport, url, auth_json }) => {
		const authJson = auth_json.trim();
		try {
			assertPublicHttpsUrl(url);
		} catch (e) {
			error(400, e instanceof Error ? e.message : 'Invalid URL');
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
			url,
			authJson: authJson || null,
		});
		redirect(303, '/settings');
	},
);

export const removeMcpServer = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
		await deleteMcpServer(getEnv(), id);
		redirect(303, '/settings');
	},
);

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
	z
		.object({
			name: z
				.string()
				.trim()
				.refine((v) => v.length > 0 && isValidSubAgentName(v), SUB_AGENT_NAME_RULE),
			description: trimmedNonEmpty('Description is required'),
			system_prompt: z.string().refine((v) => v.trim().length > 0, 'System prompt is required'),
			model: z.string().optional().default(''),
			max_iterations: z.string().optional().default(''),
			allowed_tools: z.string().optional().default(''),
		})
		.superRefine((d, ctx) => {
			const raw = d.max_iterations.trim();
			if (!raw) return;
			const n = Number.parseInt(raw, 10);
			if (!Number.isFinite(n) || n < 1 || n > 50) {
				ctx.addIssue({
					code: 'custom',
					path: ['max_iterations'],
					message: 'max_iterations must be an integer between 1 and 50',
				});
			}
		}),
	async ({ name, description, system_prompt, model, max_iterations, allowed_tools }) => {
		const modelRaw = model.trim();
		const maxIterRaw = max_iterations.trim();
		const maxIterations = maxIterRaw ? Number.parseInt(maxIterRaw, 10) : null;
		try {
			await createSubAgent(getEnv(), {
				name,
				description,
				systemPrompt: system_prompt,
				model: modelRaw || null,
				maxIterations,
				allowedTools: parseAllowedTools(allowed_tools),
			});
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const removeSubAgent = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
		await deleteSubAgent(getEnv(), id);
		redirect(303, '/settings');
	},
);

export const toggleSubAgent = form(
	z.object({ id: positiveIntFromString, enabled: z.string().optional() }),
	async ({ id, enabled }) => {
		await setSubAgentEnabled(getEnv(), id, enabled === 'true');
		redirect(303, '/settings');
	},
);

export const addMemory = form(
	z.object({ content: trimmedNonEmpty('Memory content is required') }),
	async ({ content }) => {
		try {
			await createMemory(getEnv(), { type: 'manual', content, source: 'user' });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const removeMemory = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
		await deleteMemory(getEnv(), id);
		redirect(303, '/settings');
	},
);

export const addStyle = form(
	z.object({
		name: trimmedNonEmpty('Name is required'),
		system_prompt: z.string().refine((v) => v.trim().length > 0, 'System prompt is required'),
	}),
	async ({ name, system_prompt }) => {
		try {
			await createStyle(getEnv(), { name, systemPrompt: system_prompt });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const saveStyle = form(
	z.object({
		id: positiveIntFromString,
		name: trimmedNonEmpty('Name is required'),
		system_prompt: z.string().refine((v) => v.trim().length > 0, 'System prompt is required'),
	}),
	async ({ id, name, system_prompt }) => {
		try {
			await updateStyle(getEnv(), id, { name, systemPrompt: system_prompt });
		} catch (e) {
			error(400, e instanceof Error ? e.message : String(e));
		}
		redirect(303, '/settings');
	},
);

export const removeStyle = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
		await deleteStyle(getEnv(), id);
		redirect(303, '/settings');
	},
);

// Add an MCP server from the curated catalog. For OAuth-protected servers we
// create the row with `enabled = 0` and immediately redirect into the OAuth
// connect flow; for header-auth or no-auth servers we just create and return
// to settings.
export const addMcpFromPreset = form(
	z.object({ preset_id: trimmedNonEmpty('Unknown MCP preset') }),
	async ({ preset_id }) => {
		const preset = getMcpPreset(preset_id);
		if (!preset) error(400, `Unknown MCP preset: ${preset_id}`);
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
	},
);

export const disconnectMcpServer = form(
	z.object({ id: positiveIntFromString }),
	async ({ id }) => {
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
	},
);
