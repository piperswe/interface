// `get_models` tool: lists the user's curated model catalogue and the model
// the parent agent is currently running on. The main agent is expected to
// call this before delegating to a sub-agent (see the `agent` tool's
// description), then ask the user which model the sub-agent should use.

import type { ModelEntry } from '../models/config';
import type { Tool, ToolExecutionResult } from './registry';

export type GetModelsToolDeps = {
	currentModel: string;
	availableModels: ModelEntry[];
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
				lines.push('', 'No curated model list configured.');
			} else {
				lines.push('', 'Available models:');
				for (const m of deps.availableModels) {
					const isCurrent = m.slug === deps.currentModel;
					lines.push(`- ${m.slug}${m.label && m.label !== m.slug ? ` (${m.label})` : ''}${isCurrent ? ' [current]' : ''}`);
				}
			}
			return { content: lines.join('\n') };
		},
	};
}
