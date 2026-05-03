// `agent` tool: dispatch a task to a configured sub-agent. The sub-agent
// runs its own LLM loop with a custom system prompt, a curated tool subset,
// and the parent's prompt as user input. Returns the final text response
// back to the caller as a single tool result.
//
// Recursion guard: sub-agents never get the `agent` tool registered into
// their own loop (handled in `createAgentTool`'s `innerToolRegistry` filter),
// so a sub-agent cannot delegate again.

import { routeLLM as defaultRouteLLM } from '../llm/route';
import type { ChatRequest, ContentBlock, Message, ToolDefinition } from '../llm/LLM';
import type LLM from '../llm/LLM';
import { getSubAgentByName, type SubAgentRow } from '../sub_agents';
import { ToolRegistry, type Tool, type ToolContext, type ToolExecutionResult } from './registry';

const DEFAULT_MAX_INNER_ITERATIONS = 5;
const AGENT_TOOL_NAME = 'agent';

export type AgentToolDeps = {
	// Build the registry of tools the sub-agent can choose from. The same
	// builder used for the parent loop, minus the `agent` tool itself
	// (filtered by the agent tool's executor before passing to the LLM).
	buildInnerToolRegistry(): Promise<ToolRegistry>;
	// Default model when a sub-agent doesn't specify one — the parent
	// conversation's model.
	defaultModel: string;
	// User-id scoping. Single-user mode passes 1; multi-user passes the
	// session user.
	userId?: number;
	// LLM factory; defaults to `routeLLM`. Tests inject a fake.
	routeLLM?: (env: Env, model: string) => LLM;
};

export function createAgentTool(deps: AgentToolDeps, subAgents: SubAgentRow[]): Tool | null {
	const enabled = subAgents.filter((sa) => sa.enabled);
	if (enabled.length === 0) return null;

	const enumNames = enabled.map((sa) => sa.name);
	const lines = ['Available sub-agents:'];
	for (const sa of enabled) {
		lines.push(`- \`${sa.name}\`: ${sa.description}`);
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
		},
		required: ['subagent_type', 'prompt'],
	} as const;

	return {
		definition: {
			name: AGENT_TOOL_NAME,
			description: [
				'Delegate a self-contained task to a specialised sub-agent. The sub-agent runs its own LLM loop with a custom system prompt and a curated tool subset, then returns its final answer as a single block of text. Use when a task benefits from a focused persona or a different tool scope, or when offloading multi-step work that would clutter the main thread.',
				'',
				lines.join('\n'),
			].join('\n'),
			inputSchema,
		},
		async execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
			const args = (input ?? {}) as { subagent_type?: string; prompt?: string };
			if (!args.subagent_type || typeof args.subagent_type !== 'string') {
				return { content: 'Missing required parameter: subagent_type', isError: true };
			}
			if (!args.prompt || typeof args.prompt !== 'string') {
				return { content: 'Missing required parameter: prompt', isError: true };
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
			// Strip the agent tool itself to prevent recursion, then narrow to
			// the sub-agent's allow-list when one is set.
			const allowed = subAgent.allowedTools;
			const innerTools: ToolDefinition[] = innerRegistry
				.definitions()
				.filter((d) => d.name !== AGENT_TOOL_NAME)
				.filter((d) => (allowed ? allowed.includes(d.name) : true));

			const model = subAgent.model && subAgent.model.trim() ? subAgent.model : deps.defaultModel;
			const llm = (deps.routeLLM ?? defaultRouteLLM)(ctx.env, model);

			const messages: Message[] = [{ role: 'user', content: args.prompt }];
			const maxIter = subAgent.maxIterations && subAgent.maxIterations > 0 ? subAgent.maxIterations : DEFAULT_MAX_INNER_ITERATIONS;

			let finalText = '';

			for (let iter = 0; iter < maxIter; iter++) {
				const turnToolCalls: { id: string; name: string; input: unknown }[] = [];
				let turnText = '';
				let providerError: string | null = null;

				const req: ChatRequest = {
					messages,
					systemPrompt: subAgent.systemPrompt,
					...(innerTools.length > 0 ? { tools: innerTools } : {}),
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
							signal: ctx.signal,
						},
						call.name,
						call.input,
					);
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
			if (!trimmed) {
				return {
					content: `Sub-agent "${subAgent.name}" exhausted its ${maxIter}-iteration budget without producing a final answer.`,
					isError: true,
				};
			}
			// Prefix with a small header so the parent agent — and the UI —
			// can tell at a glance which sub-agent produced this block.
			return { content: `[${subAgent.name}] ${trimmed}` };
		},
	};
}
