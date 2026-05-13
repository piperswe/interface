// Sub-agents: per-user specialised agents the main conversation can delegate
// to via the built-in `agent` tool. Storage is D1; the inner agent loop lives
// in `tools/agent.ts`. See migration 0004.

import { z } from 'zod';
import { parseJsonWith } from '$lib/zod-utils';
import { now as nowMs } from './clock';

// `tools_json` is historically lenient: a row written by an old code path
// might mix in non-string entries, which we want to filter rather than
// reject. So validate the outer shape (an array) but filter entries
// per-element.
const allowedToolsArrayShapeSchema = z.array(z.unknown());

const SINGLE_USER_ID = 1;

// Sub-agent names appear inside the `agent` tool's enum schema and as the
// suffix of the namespaced internal tool id. We constrain to a snake_case-ish
// shape so the model gets a stable, predictable identifier.
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type SubAgentRow = {
	id: number;
	name: string;
	description: string;
	systemPrompt: string;
	model: string | null;
	maxIterations: number | null;
	allowedTools: string[] | null;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
};

type Row = {
	id: number;
	name: string;
	description: string;
	system_prompt: string;
	model: string | null;
	max_iterations: number | null;
	tools_json: string | null;
	enabled: number;
	created_at: number;
	updated_at: number;
};

function parseTools(json: string | null): string[] | null {
	if (!json) return null;
	const parsed = parseJsonWith(allowedToolsArrayShapeSchema, json);
	if (!parsed) return null;
	const names = parsed.filter((x): x is string => typeof x === 'string');
	return names.length > 0 ? names : null;
}

function rowToSubAgent(r: Row): SubAgentRow {
	return {
		allowedTools: parseTools(r.tools_json),
		createdAt: r.created_at,
		description: r.description,
		enabled: r.enabled === 1,
		id: r.id,
		maxIterations: r.max_iterations,
		model: r.model,
		name: r.name,
		systemPrompt: r.system_prompt,
		updatedAt: r.updated_at,
	};
}

export function isValidSubAgentName(name: string): boolean {
	return NAME_PATTERN.test(name);
}

export async function listSubAgents(env: Env, userId: number = SINGLE_USER_ID): Promise<SubAgentRow[]> {
	const result = await env.DB.prepare(
		`SELECT id, name, description, system_prompt, model, max_iterations, tools_json, enabled, created_at, updated_at
		 FROM sub_agents WHERE user_id = ? ORDER BY name`,
	)
		.bind(userId)
		.all<Row>();
	return (result.results ?? []).map(rowToSubAgent);
}

export async function getSubAgent(env: Env, id: number): Promise<SubAgentRow | null> {
	const row = await env.DB.prepare(
		`SELECT id, name, description, system_prompt, model, max_iterations, tools_json, enabled, created_at, updated_at
		 FROM sub_agents WHERE id = ?`,
	)
		.bind(id)
		.first<Row>();
	return row ? rowToSubAgent(row) : null;
}

export async function getSubAgentByName(env: Env, name: string, userId: number = SINGLE_USER_ID): Promise<SubAgentRow | null> {
	const row = await env.DB.prepare(
		`SELECT id, name, description, system_prompt, model, max_iterations, tools_json, enabled, created_at, updated_at
		 FROM sub_agents WHERE user_id = ? AND name = ?`,
	)
		.bind(userId, name)
		.first<Row>();
	return row ? rowToSubAgent(row) : null;
}

export type CreateSubAgentInput = {
	name: string;
	description: string;
	systemPrompt: string;
	model?: string | null;
	maxIterations?: number | null;
	allowedTools?: string[] | null;
};

export async function createSubAgent(env: Env, input: CreateSubAgentInput, userId: number = SINGLE_USER_ID): Promise<number> {
	if (!isValidSubAgentName(input.name)) {
		throw new Error('Sub-agent name must start with a letter and contain only lowercase letters, digits, underscores, or hyphens.');
	}
	if (!input.description.trim()) throw new Error('Description is required');
	if (!input.systemPrompt.trim()) throw new Error('System prompt is required');
	const now = nowMs();
	const toolsJson = input.allowedTools && input.allowedTools.length > 0 ? JSON.stringify(input.allowedTools) : null;
	const result = await env.DB.prepare(
		`INSERT INTO sub_agents (user_id, name, description, system_prompt, model, max_iterations, tools_json, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
		 RETURNING id`,
	)
		.bind(
			userId,
			input.name,
			input.description.trim(),
			input.systemPrompt,
			input.model ?? null,
			input.maxIterations ?? null,
			toolsJson,
			now,
			now,
		)
		.first<{ id: number }>();
	return result?.id ?? 0;
}

export type UpdateSubAgentInput = Partial<CreateSubAgentInput> & { enabled?: boolean };

export async function updateSubAgent(env: Env, id: number, input: UpdateSubAgentInput, userId: number = SINGLE_USER_ID): Promise<void> {
	const existing = await env.DB.prepare(`SELECT id FROM sub_agents WHERE id = ? AND user_id = ?`).bind(id, userId).first<{ id: number }>();
	if (!existing) return;
	if (input.name !== undefined && !isValidSubAgentName(input.name)) {
		throw new Error('Sub-agent name must start with a letter and contain only lowercase letters, digits, underscores, or hyphens.');
	}
	const sets: string[] = [];
	const values: unknown[] = [];
	if (input.name !== undefined) {
		sets.push('name = ?');
		values.push(input.name);
	}
	if (input.description !== undefined) {
		sets.push('description = ?');
		values.push(input.description.trim());
	}
	if (input.systemPrompt !== undefined) {
		sets.push('system_prompt = ?');
		values.push(input.systemPrompt);
	}
	if (input.model !== undefined) {
		sets.push('model = ?');
		values.push(input.model);
	}
	if (input.maxIterations !== undefined) {
		sets.push('max_iterations = ?');
		values.push(input.maxIterations);
	}
	if (input.allowedTools !== undefined) {
		sets.push('tools_json = ?');
		values.push(input.allowedTools && input.allowedTools.length > 0 ? JSON.stringify(input.allowedTools) : null);
	}
	if (input.enabled !== undefined) {
		sets.push('enabled = ?');
		values.push(input.enabled ? 1 : 0);
	}
	if (sets.length === 0) return;
	sets.push('updated_at = ?');
	values.push(nowMs());
	values.push(id, userId);
	await env.DB.prepare(`UPDATE sub_agents SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
		.bind(...values)
		.run();
}

export async function deleteSubAgent(env: Env, id: number, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM sub_agents WHERE id = ? AND user_id = ?').bind(id, userId).run();
}

export async function setSubAgentEnabled(env: Env, id: number, enabled: boolean, userId: number = SINGLE_USER_ID): Promise<void> {
	await updateSubAgent(env, id, { enabled }, userId);
}
