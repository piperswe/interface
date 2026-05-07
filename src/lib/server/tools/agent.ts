// `agent` tool: dispatch a task to a configured sub-agent. The sub-agent
// runs its own LLM loop with a custom system prompt, a curated tool subset,
// and the parent's prompt as user input. Returns the final text response
// back to the caller as a single tool result.
//
// Recursion guard: sub-agents never get the `agent` tool registered into
// their own loop (handled in `createAgentTool`'s `innerToolRegistry` filter),
// so a sub-agent cannot delegate again.

import { z } from 'zod';
import { safeValidate } from '$lib/zod-utils';
import { routeLLMByGlobalId } from '../llm/route';
import type { ChatRequest, ContentBlock, Message, ToolDefinition } from '../llm/LLM';
import type LLM from '../llm/LLM';
import { getSubAgentByName, type SubAgentRow } from '../sub_agents';
import { ToolRegistry, type Tool, type ToolArtifactSpec, type ToolCitation, type ToolContext, type ToolExecutionResult } from './registry';

const inputArgsSchema = z.object({
	subagent_type: z.string(),
	prompt: z.string(),
	model: z.string(),
});

const DEFAULT_MAX_INNER_ITERATIONS = 5;
const AGENT_TOOL_NAME = 'agent';

export type AgentToolDeps = {
	// Build the registry of tools the sub-agent can choose from. The same
	// builder used for the parent loop, minus the `agent` tool itself
	// (filtered by the agent tool's executor before passing to the LLM).
	buildInnerToolRegistry(): Promise<ToolRegistry>;
	// Default model when neither the call site nor the sub-agent
	// configuration specifies one — the parent conversation's model.
	defaultModel: string;
	// Global IDs of the operator-curated model list. Used to validate the
	// `model` argument the parent agent passes when delegating.
	availableModelGlobalIds?: string[];
	// User-id scoping. Single-user mode passes 1; multi-user passes the
	// session user.
	userId?: number;
	// LLM factory; defaults to `routeLLMByGlobalId`. Tests inject a fake.
	routeLLM?: (env: Env, globalId: string) => Promise<LLM>;
};

export function createAgentTool(deps: AgentToolDeps, subAgents: SubAgentRow[]): Tool | null {
	const enabled = subAgents.filter((sa) => sa.enabled);
	if (enabled.length === 0) return null;

	const enumNames = enabled.map((sa) => sa.name);
	const lines = ['Available sub-agents:'];
	for (const sa of enabled) {
		lines.push(`- \`${sa.name}\`: ${sa.description}`);
	}

	const globalIds = deps.availableModelGlobalIds ?? [];
	const modelProperty: Record<string, unknown> = {
		type: 'string',
		description:
			"Model global ID to run the sub-agent on (format: {provider_id}/{model_id}). REQUIRED — confirm with the user before delegating; do not guess. Use the `get_models` tool to see the user's available models and the model the parent is currently running on.",
	};
	if (globalIds.length > 0) {
		modelProperty.enum = globalIds;
	}

	const inputSchema = {
		type: 'object',
		properties: {
			subagent_type: {
				type: 'string',
				enum: enumNames,
				description: 'Identifier of the sub-agent to delegate to.',
			},
			prompt: {
				type: 'string',
				description:
					'A self-contained brief for the sub-agent: what to do, why, and what form the answer should take. The sub-agent has no view of the parent conversation, so include all context it needs to act.',
			},
			model: modelProperty,
		},
		required: ['subagent_type', 'prompt', 'model'],
	} as const;

	return {
		definition: {
			name: AGENT_TOOL_NAME,
			description: [
				'Delegate a self-contained task to a specialised sub-agent. The sub-agent runs its own LLM loop with a custom system prompt and a curated tool subset, then returns its final answer as a single block of text. Use when a task benefits from a focused persona or a different tool scope, or when offloading multi-step work that would clutter the main thread.',
				'',
				"IMPORTANT: Always ask the user which model the sub-agent should run on before invoking this tool, unless they have already specified one in this conversation. Use `get_models` to enumerate the user's available models and the model you (the parent) are currently running on, then ask the user to pick one.",
				'',
				lines.join('\n'),
			].join('\n'),
			inputSchema,
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const parsed = safeValidate(inputArgsSchema, input);
			if (!parsed.ok) {
				return { content: `Invalid input: ${parsed.error}`, isError: true, errorCode: 'invalid_input' };
			}
			const args = parsed.value;
			if (!args.model.trim()) {
				return {
					content:
						'Missing required parameter: model. Ask the user which model the sub-agent should run on (use `get_models` to see options) and try again.',
					isError: true,
				};
			}
			const requestedModel = args.model.trim();
			if (globalIds.length > 0 && !globalIds.includes(requestedModel)) {
				return {
					content: `Model "${requestedModel}" is not in the user's configured model list. Available: ${globalIds.join(', ')}.`,
					isError: true,
				};
			}
			const subAgent = await getSubAgentByName(ctx.env, args.subagent_type, deps.userId ?? 1);
			if (!subAgent) {
				return {
					content: `Unknown sub-agent: ${args.subagent_type}. Available: ${enumNames.join(', ')}`,
					isError: true,
				};
			}
			if (!subAgent.enabled) {
				return { content: `Sub-agent "${args.subagent_type}" is disabled.`, isError: true };
			}

			const innerRegistry = await deps.buildInnerToolRegistry();
			const allowed = subAgent.allowedTools;
			const innerTools: ToolDefinition[] = innerRegistry
				.definitions()
				.filter((d) => d.name !== AGENT_TOOL_NAME)
				.filter((d) => (allowed ? allowed.includes(d.name) : true));

			const model = requestedModel || (subAgent.model && subAgent.model.trim() ? subAgent.model : deps.defaultModel);
			const llm = await (deps.routeLLM ?? routeLLMByGlobalId)(ctx.env, model);

			const messages: Message[] = [{ role: 'user', content: args.prompt }];
			const maxIter = subAgent.maxIterations && subAgent.maxIterations > 0 ? subAgent.maxIterations : DEFAULT_MAX_INNER_ITERATIONS;

			let finalText = '';
			let stoppedNaturally = false;
			const accumulatedCitations: ToolCitation[] = [];
			const accumulatedArtifacts: ToolArtifactSpec[] = [];

			for (let iter = 0; iter < maxIter; iter++) {
				if (ctx.signal?.aborted) {
					return { content: `Sub-agent "${subAgent.name}" cancelled.`, isError: true };
				}
				const turnToolCalls: { id: string; name: string; input: unknown }[] = [];
				let turnText = '';
				let providerError: string | null = null;

				const req: ChatRequest = {
					messages,
					systemPrompt: subAgent.systemPrompt,
					...(innerTools.length > 0 ? { tools: innerTools } : {}),
					...(ctx.signal ? { signal: ctx.signal } : {}),
				};

				for await (const ev of llm.chat(req)) {
					if (ev.type === 'text_delta') {
						turnText += ev.delta;
					} else if (ev.type === 'tool_call') {
						turnToolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
					} else if (ev.type === 'error') {
						providerError = ev.message;
					}
				}

				if (providerError) {
					return { content: `Sub-agent "${subAgent.name}" failed: ${providerError}`, isError: true };
				}

				if (turnToolCalls.length === 0) {
					finalText = turnText;
					stoppedNaturally = true;
					break;
				}

				const assistantBlocks: ContentBlock[] = [];
				if (turnText) assistantBlocks.push({ type: 'text', text: turnText });
				for (const tc of turnToolCalls) {
					assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
				}
				messages.push({ role: 'assistant', content: assistantBlocks });

				for (const call of turnToolCalls) {
					if (allowed && !allowed.includes(call.name)) {
						messages.push({
							role: 'tool',
							content: [
								{
									type: 'tool_result',
									toolUseId: call.id,
									content: `Tool "${call.name}" is not available to sub-agent "${subAgent.name}".`,
									isError: true,
								},
							],
						});
						continue;
					}
					if (call.name === AGENT_TOOL_NAME) {
						messages.push({
							role: 'tool',
							content: [
								{
									type: 'tool_result',
									toolUseId: call.id,
									content: 'Sub-agents cannot delegate to other sub-agents.',
									isError: true,
								},
							],
						});
						continue;
					}
					const result = await innerRegistry.execute(
						{
							env: ctx.env,
							conversationId: ctx.conversationId,
							assistantMessageId: ctx.assistantMessageId,
							modelId: model,
							signal: ctx.signal,
							// Forward the parent's `registerCitation` so a sub-agent
							// that runs `web_search` shares the parent turn's global
							// citation numbering. The sub-agent's own text becomes
							// the parent's tool result content (not user-facing
							// markdown), so inline `[N]` markers in it never get
							// rendered as citations — but the parent reading the
							// result can reference the same `[N]` indices in its own
							// reply, and they'll resolve to the right Sources entry.
							registerCitation: ctx.registerCitation,
						},
						call.name,
						call.input,
					);
					if (result.citations) {
						// Legacy path for tools that don't use registerCitation.
						// Forward to the parent if available (so they share the
						// global namespace); otherwise just accumulate locally to
						// surface to the parent via this tool's return value.
						if (ctx.registerCitation) {
							for (const c of result.citations) ctx.registerCitation(c);
						} else {
							accumulatedCitations.push(...result.citations);
						}
					}
					if (result.artifacts) accumulatedArtifacts.push(...result.artifacts);
					messages.push({
						role: 'tool',
						content: [
							{
								type: 'tool_result',
								toolUseId: call.id,
								content: result.content,
								...(result.isError ? { isError: true } : {}),
							},
						],
					});
				}
			}

			const trimmed = finalText.trim();
			if (!stoppedNaturally) {
				return {
					content: `Sub-agent "${subAgent.name}" exhausted its ${maxIter}-iteration budget without producing a final answer.`,
					isError: true,
				};
			}
			if (!trimmed) {
				return {
					content: `Sub-agent "${subAgent.name}" returned an empty response.`,
					isError: true,
				};
			}
			return {
				content: `[${subAgent.name}] ${trimmed}`,
				// When the parent provides `registerCitation`, sub-agent tool
				// citations have already been merged into the parent's global
				// list, so don't surface them here too.
				...(!ctx.registerCitation && accumulatedCitations.length > 0
					? { citations: accumulatedCitations }
					: {}),
				...(accumulatedArtifacts.length > 0 ? { artifacts: accumulatedArtifacts } : {}),
			};
		},
	};
}
