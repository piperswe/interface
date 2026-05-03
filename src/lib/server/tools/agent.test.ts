import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { createSubAgent } from '../sub_agents';
import type LLM from '../llm/LLM';
import type { ChatRequest, StreamEvent } from '../llm/LLM';
import { ToolRegistry, type Tool } from './registry';
import { createAgentTool } from './agent';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM sub_agents').run();
});

const echoTool: Tool = {
	definition: {
		name: 'echo',
		description: 'echoes input.text',
		inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
	},
	async execute(_ctx, input) {
		const args = input as { text?: string };
		return { content: `echo:${args.text ?? ''}` };
	},
};

// Scripted LLM: returns a queue of canned stream sequences, one per chat() call.
class ScriptedLLM implements LLM {
	model = 'fake-model';
	providerID = 'fake';
	#turns: StreamEvent[][];
	calls: ChatRequest[] = [];
	constructor(turns: StreamEvent[][]) {
		this.#turns = turns;
	}
	async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
		this.calls.push(request);
		const events = this.#turns.shift() ?? [];
		for (const ev of events) yield ev;
	}
}

const ctx = { env, conversationId: 'c-1', assistantMessageId: 'a-1' };

describe('createAgentTool', () => {
	it('returns null when no sub-agents are configured', () => {
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
			},
			[],
		);
		expect(tool).toBeNull();
	});

	it('returns null when all sub-agents are disabled', async () => {
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
			},
			[
				{
					id: 1,
					name: 'r',
					description: 'd',
					systemPrompt: 's',
					model: null,
					maxIterations: null,
					allowedTools: null,
					enabled: false,
					createdAt: 0,
					updatedAt: 0,
				},
			],
		);
		expect(tool).toBeNull();
	});

	it('describes available sub-agents in the tool definition', async () => {
		await createSubAgent(env, { name: 'researcher', description: 'Research a topic', systemPrompt: 'sp' });
		await createSubAgent(env, { name: 'reviewer', description: 'Review code', systemPrompt: 'sp' });
		const subAgents = (await import('../sub_agents')).listSubAgents;
		const list = await subAgents(env);
		const tool = createAgentTool(
			{ buildInnerToolRegistry: async () => new ToolRegistry(), defaultModel: 'fake-model' },
			list,
		);
		expect(tool).not.toBeNull();
		expect(tool!.definition.name).toBe('agent');
		expect(tool!.definition.description).toContain('researcher');
		expect(tool!.definition.description).toContain('reviewer');
		const schema = tool!.definition.inputSchema as { properties: { subagent_type: { enum: string[] } } };
		expect(schema.properties.subagent_type.enum.sort()).toEqual(['researcher', 'reviewer']);
	});

	it('runs a one-turn sub-agent that produces a final answer', async () => {
		await createSubAgent(env, { name: 'r', description: 'd', systemPrompt: 'You are r.' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([
			[
				{ type: 'text_delta', delta: 'final answer' },
				{ type: 'done' },
			],
		]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
				routeLLM: () => llm,
			},
			list,
		)!;
		const result = await tool.execute(ctx, { subagent_type: 'r', prompt: 'do the thing' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe('[r] final answer');
		expect(llm.calls[0].systemPrompt).toBe('You are r.');
		expect(llm.calls[0].messages).toEqual([{ role: 'user', content: 'do the thing' }]);
	});

	it('runs the inner tool loop, executing tool calls and feeding results back', async () => {
		await createSubAgent(env, { name: 'r', description: 'd', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([
			[
				{ type: 'tool_call', id: 'tc-1', name: 'echo', input: { text: 'hi' } },
				{ type: 'done' },
			],
			[
				{ type: 'text_delta', delta: 'I called echo and got a result.' },
				{ type: 'done' },
			],
		]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry().register(echoTool),
				defaultModel: 'fake-model',
				routeLLM: () => llm,
			},
			list,
		)!;
		const result = await tool.execute(ctx, { subagent_type: 'r', prompt: 'use echo' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe('[r] I called echo and got a result.');
		// Second turn must include the tool_result feeding back.
		const turn2 = llm.calls[1];
		const toolResultMsg = turn2.messages.find((m) => m.role === 'tool');
		expect(toolResultMsg).toBeDefined();
		expect(JSON.stringify(toolResultMsg)).toContain('echo:hi');
	});

	it('prevents sub-agents from calling the agent tool', async () => {
		await createSubAgent(env, { name: 'r', description: 'd', systemPrompt: 'sp', maxIterations: 2 });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([
			[
				{ type: 'tool_call', id: 'tc-1', name: 'agent', input: { subagent_type: 'r', prompt: 'recurse' } },
				{ type: 'done' },
			],
			[
				{ type: 'text_delta', delta: 'Got it.' },
				{ type: 'done' },
			],
		]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
				routeLLM: () => llm,
			},
			list,
		)!;
		const result = await tool.execute(ctx, { subagent_type: 'r', prompt: 'try to recurse' });
		expect(result.content).toBe('[r] Got it.');
		const turn2 = llm.calls[1];
		const toolResultMsg = turn2.messages.find((m) => m.role === 'tool');
		expect(JSON.stringify(toolResultMsg)).toContain('cannot delegate');
	});

	it('rejects tool calls outside the sub-agent allowed list', async () => {
		await createSubAgent(env, {
			name: 'r',
			description: 'd',
			systemPrompt: 'sp',
			allowedTools: ['echo'],
			maxIterations: 2,
		});
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const banned: Tool = {
			definition: { name: 'banned', description: '', inputSchema: { type: 'object' } },
			async execute() {
				throw new Error('should not run');
			},
		};
		const llm = new ScriptedLLM([
			[
				{ type: 'tool_call', id: 'tc-1', name: 'banned', input: {} },
				{ type: 'done' },
			],
			[
				{ type: 'text_delta', delta: 'noted' },
				{ type: 'done' },
			],
		]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry().register(echoTool).register(banned),
				defaultModel: 'fake-model',
				routeLLM: () => llm,
			},
			list,
		)!;
		const result = await tool.execute(ctx, { subagent_type: 'r', prompt: 'run banned' });
		expect(result.content).toBe('[r] noted');
		// First-turn tools list passed to the LLM must only include `echo`.
		const turn1 = llm.calls[0];
		expect(turn1.tools?.map((t) => t.name).sort()).toEqual(['echo']);
		// And the banned call gets a "not available" tool_result.
		const toolResultMsg = llm.calls[1].messages.find((m) => m.role === 'tool');
		expect(JSON.stringify(toolResultMsg)).toContain('not available');
	});

	it('returns an error when the sub-agent does not exist', async () => {
		await createSubAgent(env, { name: 'r', description: 'd', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
				routeLLM: () => new ScriptedLLM([]),
			},
			list,
		)!;
		const result = await tool.execute(ctx, { subagent_type: 'unknown', prompt: 'x' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('Unknown sub-agent');
	});

	it('returns an error when the sub-agent exhausts its iteration budget', async () => {
		await createSubAgent(env, { name: 'r', description: 'd', systemPrompt: 'sp', maxIterations: 1 });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([
			[
				{ type: 'tool_call', id: 'tc-1', name: 'echo', input: { text: 'a' } },
				{ type: 'done' },
			],
		]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry().register(echoTool),
				defaultModel: 'fake-model',
				routeLLM: () => llm,
			},
			list,
		)!;
		const result = await tool.execute(ctx, { subagent_type: 'r', prompt: 'loop' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('exhausted');
	});

	it('surfaces provider errors from the inner LLM', async () => {
		await createSubAgent(env, { name: 'r', description: 'd', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([[{ type: 'error', message: 'boom' }]]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
				routeLLM: () => llm,
			},
			list,
		)!;
		const result = await tool.execute(ctx, { subagent_type: 'r', prompt: 'x' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('boom');
	});

	it('uses the parent default model when the sub-agent has none', async () => {
		await createSubAgent(env, { name: 'r', description: 'd', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const seen: string[] = [];
		const llm = new ScriptedLLM([[{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'parent-model',
				routeLLM: (_env, model) => {
					seen.push(model);
					return llm;
				},
			},
			list,
		)!;
		await tool.execute(ctx, { subagent_type: 'r', prompt: 'x' });
		expect(seen).toEqual(['parent-model']);
	});

	it('uses the sub-agent override model when set', async () => {
		await createSubAgent(env, { name: 'r', description: 'd', systemPrompt: 'sp', model: 'override-model' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const seen: string[] = [];
		const llm = new ScriptedLLM([[{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'parent-model',
				routeLLM: (_env, model) => {
					seen.push(model);
					return llm;
				},
			},
			list,
		)!;
		await tool.execute(ctx, { subagent_type: 'r', prompt: 'x' });
		expect(seen).toEqual(['override-model']);
	});
});
