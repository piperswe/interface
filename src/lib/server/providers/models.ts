// D1 CRUD for provider_models. A model's global ID is `{provider_id}/{model_id}`.

import { now as nowMs } from '../clock';
import type { ProviderModel, ReasoningType, ResolvedModel } from './types';
import { buildGlobalModelId, parseGlobalModelId } from './types';
import { getProvider } from './store';

const SINGLE_USER_ID = 1;

type ModelRow = {
	id: string;
	provider_id: string;
	name: string;
	description: string | null;
	max_context_length: number;
	reasoning_type: string | null;
	input_cost_per_million_tokens: number | null;
	output_cost_per_million_tokens: number | null;
	supports_image_input: number;
	sort_order: number;
	created_at: number;
	updated_at: number;
};

const MODEL_COLUMNS =
	'id, provider_id, name, description, max_context_length, reasoning_type, input_cost_per_million_tokens, output_cost_per_million_tokens, supports_image_input, sort_order, created_at, updated_at';

function rowToModel(r: ModelRow): ProviderModel {
	return {
		id: r.id,
		providerId: r.provider_id,
		name: r.name,
		description: r.description,
		maxContextLength: r.max_context_length,
		reasoningType: (r.reasoning_type as ReasoningType | null) ?? null,
		inputCostPerMillionTokens: r.input_cost_per_million_tokens,
		outputCostPerMillionTokens: r.output_cost_per_million_tokens,
		supportsImageInput: !!r.supports_image_input,
		sortOrder: r.sort_order,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export async function listModelsForProvider(env: Env, providerId: string, userId: number = SINGLE_USER_ID): Promise<ProviderModel[]> {
	const result = await env.DB.prepare(
		`SELECT ${MODEL_COLUMNS}
		 FROM provider_models WHERE user_id = ? AND provider_id = ? ORDER BY sort_order ASC, name ASC`,
	)
		.bind(userId, providerId)
		.all<ModelRow>();
	return (result.results ?? []).map(rowToModel);
}

export async function listAllModels(env: Env, userId: number = SINGLE_USER_ID): Promise<ProviderModel[]> {
	const result = await env.DB.prepare(
		`SELECT ${MODEL_COLUMNS}
		 FROM provider_models WHERE user_id = ? ORDER BY provider_id ASC, sort_order ASC, name ASC`,
	)
		.bind(userId)
		.all<ModelRow>();
	return (result.results ?? []).map(rowToModel);
}

export async function getModel(
	env: Env,
	providerId: string,
	modelId: string,
	userId: number = SINGLE_USER_ID,
): Promise<ProviderModel | null> {
	const row = await env.DB.prepare(
		`SELECT ${MODEL_COLUMNS}
		 FROM provider_models WHERE user_id = ? AND provider_id = ? AND id = ?`,
	)
		.bind(userId, providerId, modelId)
		.first<ModelRow>();
	return row ? rowToModel(row) : null;
}

export async function getResolvedModel(env: Env, globalId: string, userId: number = SINGLE_USER_ID): Promise<ResolvedModel | null> {
	const { providerId, modelId } = parseGlobalModelId(globalId);
	const [provider, model] = await Promise.all([getProvider(env, providerId, userId), getModel(env, providerId, modelId, userId)]);
	if (!provider || !model) return null;
	return { globalId, provider, model };
}

export type CreateModelInput = {
	id: string;
	name: string;
	description?: string | null;
	maxContextLength?: number;
	reasoningType?: ReasoningType | null;
	inputCostPerMillionTokens?: number | null;
	outputCostPerMillionTokens?: number | null;
	supportsImageInput?: boolean;
	sortOrder?: number;
};

export async function createModel(env: Env, providerId: string, input: CreateModelInput, userId: number = SINGLE_USER_ID): Promise<void> {
	const now = nowMs();
	await env.DB.prepare(
		`INSERT INTO provider_models (id, provider_id, name, description, max_context_length, reasoning_type, input_cost_per_million_tokens, output_cost_per_million_tokens, supports_image_input, sort_order, created_at, updated_at, user_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.id,
			providerId,
			input.name,
			input.description ?? null,
			input.maxContextLength ?? 128_000,
			input.reasoningType ?? null,
			input.inputCostPerMillionTokens ?? null,
			input.outputCostPerMillionTokens ?? null,
			input.supportsImageInput ? 1 : 0,
			input.sortOrder ?? 0,
			now,
			now,
			userId,
		)
		.run();
}

export type UpdateModelInput = Partial<Omit<CreateModelInput, 'id'>>;

export async function updateModel(
	env: Env,
	providerId: string,
	modelId: string,
	input: UpdateModelInput,
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	const now = nowMs();
	const fields: string[] = [];
	const values: (string | number | null)[] = [];

	if ('name' in input) {
		fields.push('name = ?');
		values.push(input.name!);
	}
	if ('description' in input) {
		fields.push('description = ?');
		values.push(input.description ?? null);
	}
	if ('maxContextLength' in input) {
		fields.push('max_context_length = ?');
		values.push(input.maxContextLength ?? 128_000);
	}
	if ('reasoningType' in input) {
		fields.push('reasoning_type = ?');
		values.push(input.reasoningType ?? null);
	}
	if ('inputCostPerMillionTokens' in input) {
		fields.push('input_cost_per_million_tokens = ?');
		values.push(input.inputCostPerMillionTokens ?? null);
	}
	if ('outputCostPerMillionTokens' in input) {
		fields.push('output_cost_per_million_tokens = ?');
		values.push(input.outputCostPerMillionTokens ?? null);
	}
	if ('supportsImageInput' in input) {
		fields.push('supports_image_input = ?');
		values.push(input.supportsImageInput ? 1 : 0);
	}
	if ('sortOrder' in input) {
		fields.push('sort_order = ?');
		values.push(input.sortOrder ?? 0);
	}

	if (fields.length === 0) return;

	fields.push('updated_at = ?');
	values.push(now);
	values.push(userId, providerId, modelId);

	await env.DB.prepare(`UPDATE provider_models SET ${fields.join(', ')} WHERE user_id = ? AND provider_id = ? AND id = ?`)
		.bind(...values)
		.run();
}

export async function deleteModel(env: Env, providerId: string, modelId: string, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM provider_models WHERE user_id = ? AND provider_id = ? AND id = ?')
		.bind(userId, providerId, modelId)
		.run();
}

export async function deleteModelsForProvider(env: Env, providerId: string, userId: number = SINGLE_USER_ID): Promise<void> {
	await env.DB.prepare('DELETE FROM provider_models WHERE user_id = ? AND provider_id = ?').bind(userId, providerId).run();
}

/** Move a model to a specific position within its provider's list.
 * Pass null for beforeModelId to move to the end. */
export async function moveModelToPosition(
	env: Env,
	providerId: string,
	modelId: string,
	beforeModelId: string | null,
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	const models = await listModelsForProvider(env, providerId, userId);
	const dragged = models.find((m) => m.id === modelId);
	if (!dragged) throw new Error(`Model ${modelId} not found in provider ${providerId}`);
	const originalIdx = models.findIndex((m) => m.id === modelId);
	const withoutModel = models.filter((m) => m.id !== modelId);
	let insertIdx: number;
	if (beforeModelId === null) {
		insertIdx = withoutModel.length;
	} else if (beforeModelId === modelId) {
		// Self-reference: keep at original position (no-op)
		insertIdx = originalIdx;
	} else {
		const idx = withoutModel.findIndex((m) => m.id === beforeModelId);
		// Stale/missing beforeModelId: fall back to end
		insertIdx = idx === -1 ? withoutModel.length : idx;
	}
	withoutModel.splice(insertIdx, 0, dragged);
	await Promise.all(
		withoutModel.map((m, idx) => updateModel(env, providerId, m.id, { sortOrder: idx }, userId)),
	);
}

/** Swap sort_order between two models in the same provider. */
export async function swapModelOrder(
	env: Env,
	providerId: string,
	modelIdA: string,
	modelIdB: string,
	userId: number = SINGLE_USER_ID,
): Promise<void> {
	const a = await getModel(env, providerId, modelIdA, userId);
	const b = await getModel(env, providerId, modelIdB, userId);
	if (!a || !b) throw new Error('One or both models not found');

	await Promise.all([
		updateModel(env, providerId, modelIdA, { sortOrder: b.sortOrder }, userId),
		updateModel(env, providerId, modelIdB, { sortOrder: a.sortOrder }, userId),
	]);
}

/** Convenience: return all global IDs for a given provider. */
export async function listGlobalIdsForProvider(env: Env, providerId: string, userId: number = SINGLE_USER_ID): Promise<string[]> {
	const models = await listModelsForProvider(env, providerId, userId);
	return models.map((m) => buildGlobalModelId(providerId, m.id));
}

/** Convenience: return all global IDs across all providers. */
export async function listAllGlobalModelIds(env: Env, userId: number = SINGLE_USER_ID): Promise<string[]> {
	const models = await listAllModels(env, userId);
	return models.map((m) => buildGlobalModelId(m.providerId, m.id));
}
