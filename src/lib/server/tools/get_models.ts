// `get_models` tool: lists the user's configured models grouped by provider,
// and the model the parent agent is currently running on.

import type { ProviderModel } from '../providers/types';
import type { Tool, ToolExecutionResult } from './registry';

export type GetModelsToolDeps = {
	currentModel: string;
	availableModels: ProviderModel[];
};

export function createGetModelsTool(deps: GetModelsToolDeps): Tool {
	return {
		definition: {
			name: 'get_models',
			description:
				'List the models available to this Interface deployment, plus the model you (the parent agent) are currently running on. Call this before invoking the `agent` tool so you can ask the user which model the sub-agent should run on.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		},
		async execute(): Promise<ToolExecutionResult> {
			const lines: string[] = [];
			lines.push(`Current model (parent agent): ${deps.currentModel}`);
			if (deps.availableModels.length === 0) {
				lines.push('', 'No models configured.');
			} else {
				// Group by provider for readability
				const byProvider = new Map<string, ProviderModel[]>();
				for (const m of deps.availableModels) {
					const list = byProvider.get(m.providerId) ?? [];
					list.push(m);
					byProvider.set(m.providerId, list);
				}
				lines.push('', 'Available models:');
				for (const [providerId, models] of byProvider) {
					lines.push(`\n${providerId}:`);
					for (const m of models) {
						const globalId = `${m.providerId}/${m.id}`;
						const isCurrent = globalId === deps.currentModel;
						lines.push(`  - ${globalId}${m.name && m.name !== m.id ? ` (${m.name})` : ''}${isCurrent ? ' [current]' : ''}`);
					}
				}
			}
			return { content: lines.join('\n') };
		},
	};
}
