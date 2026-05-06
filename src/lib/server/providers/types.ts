export type ProviderType = 'anthropic' | 'openai_compatible';

export interface Provider {
	id: string;
	type: ProviderType;
	apiKey: string | null;
	endpoint: string | null;
	gatewayId: string | null;
	createdAt: number;
	updatedAt: number;
}

export type ReasoningType = 'effort' | 'max_tokens';

export interface ProviderModel {
	id: string;
	providerId: string;
	name: string;
	description: string | null;
	maxContextLength: number;
	reasoningType: ReasoningType | null;
	// Optional USD price per 1,000,000 tokens. Used to compute cost when the
	// provider does not report cost directly in the usage response.
	inputCostPerMillionTokens: number | null;
	outputCostPerMillionTokens: number | null;
	// Whether the model accepts image input. Gates the `sandbox_load_image`
	// tool: when false, it returns a text fallback steering the agent to
	// existing sandbox tools (`sandbox_read_file`, `sandbox_exec`).
	supportsImageInput: boolean;
	sortOrder: number;
	createdAt: number;
	updatedAt: number;
}

export interface ResolvedModel {
	globalId: string;
	provider: Provider;
	model: ProviderModel;
}

/** Parse a global model ID into its provider and model components.
 *  Format: {provider_id}/{model_id}   (model_id may contain additional slashes)
 */
export function parseGlobalModelId(globalId: string): { providerId: string; modelId: string } {
	const i = globalId.indexOf('/');
	if (i === -1) throw new Error(`Invalid global model ID: ${globalId}`);
	return { providerId: globalId.slice(0, i), modelId: globalId.slice(i + 1) };
}

export function buildGlobalModelId(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}
