import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDefined } from '../../../../test/assert-defined';
import type LLM from '../llm/LLM';
import type { ChatRequest, StreamEvent } from '../llm/LLM';
import { createSubAgent } from '../sub_agents';
import { createAgentTool } from './agent';
import { type Tool, ToolRegistry } from './registry';

afterEach(async () => {
	await env.DB.prepare('DELETE FROM sub_agents').run();
});

const echoTool: Tool = {
	definition: {
		description: 'echoes input.text',
		inputSchema: { properties: { text: { type: 'string' } }, required: ['text'], type: 'object' },
		name: 'echo',
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

const ctx = { assistantMessageId: 'a-1', conversationId: 'c-1', env, modelId: 'fake-model' };

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
					allowedTools: null,
					createdAt: 0,
					description: 'd',
					enabled: false,
					id: 1,
					maxIterations: null,
					model: null,
					name: 'r',
					systemPrompt: 's',
					updatedAt: 0,
				},
			],
		);
		expect(tool).toBeNull();
	});

	it('describes available sub-agents in the tool definition', async () => {
		await createSubAgent(env, { description: 'Research a topic', name: 'researcher', systemPrompt: 'sp' });
		await createSubAgent(env, { description: 'Review code', name: 'reviewer', systemPrompt: 'sp' });
		const subAgents = (await import('../sub_agents')).listSubAgents;
		const list = await subAgents(env);
		const tool = createAgentTool({ buildInnerToolRegistry: async () => new ToolRegistry(), defaultModel: 'fake-model' }, list);
		expect(tool).not.toBeNull();
		assertDefined(tool);
		expect(tool.definition.name).toBe('agent');
		expect(tool.definition.description).toContain('researcher');
		expect(tool.definition.description).toContain('reviewer');
		const schema = tool.definition.inputSchema as { properties: { subagent_type: { enum: string[] } } };
		expect(schema.properties.subagent_type.enum.sort()).toEqual(['researcher', 'reviewer']);
	});

	it('runs a one-turn sub-agent that produces a final answer', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'You are r.' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([[{ delta: 'final answer', type: 'text_delta' }, { type: 'done' }]]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
				routeLLM: async () => llm,
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, { model: 'fake-model', prompt: 'do the thing', subagent_type: 'r' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe('[r] final answer');
		expect(llm.calls[0].systemPrompt).toBe('You are r.');
		expect(llm.calls[0].messages).toEqual([{ content: 'do the thing', role: 'user' }]);
	});

	it('runs the inner tool loop, executing tool calls and feeding results back', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([
			[{ id: 'tc-1', input: { text: 'hi' }, name: 'echo', type: 'tool_call' }, { type: 'done' }],
			[{ delta: 'I called echo and got a result.', type: 'text_delta' }, { type: 'done' }],
		]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry().register(echoTool),
				defaultModel: 'fake-model',
				routeLLM: async () => llm,
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, { model: 'fake-model', prompt: 'use echo', subagent_type: 'r' });
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe('[r] I called echo and got a result.');
		// Second turn must include the tool_result feeding back.
		const turn2 = llm.calls[1];
		const toolResultMsg = turn2.messages.find((m) => m.role === 'tool');
		expect(toolResultMsg).toBeDefined();
		expect(JSON.stringify(toolResultMsg)).toContain('echo:hi');
	});

	it('prevents sub-agents from calling the agent tool', async () => {
		await createSubAgent(env, { description: 'd', maxIterations: 2, name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([
			[{ id: 'tc-1', input: { prompt: 'recurse', subagent_type: 'r' }, name: 'agent', type: 'tool_call' }, { type: 'done' }],
			[{ delta: 'Got it.', type: 'text_delta' }, { type: 'done' }],
		]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
				routeLLM: async () => llm,
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, { model: 'fake-model', prompt: 'try to recurse', subagent_type: 'r' });
		expect(result.content).toBe('[r] Got it.');
		const turn2 = llm.calls[1];
		const toolResultMsg = turn2.messages.find((m) => m.role === 'tool');
		expect(JSON.stringify(toolResultMsg)).toContain('cannot delegate');
	});

	it('rejects tool calls outside the sub-agent allowed list', async () => {
		await createSubAgent(env, {
			allowedTools: ['echo'],
			description: 'd',
			maxIterations: 2,
			name: 'r',
			systemPrompt: 'sp',
		});
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const banned: Tool = {
			definition: { description: '', inputSchema: { type: 'object' }, name: 'banned' },
			async execute() {
				throw new Error('should not run');
			},
		};
		const llm = new ScriptedLLM([
			[{ id: 'tc-1', input: {}, name: 'banned', type: 'tool_call' }, { type: 'done' }],
			[{ delta: 'noted', type: 'text_delta' }, { type: 'done' }],
		]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry().register(echoTool).register(banned),
				defaultModel: 'fake-model',
				routeLLM: async () => llm,
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, { model: 'fake-model', prompt: 'run banned', subagent_type: 'r' });
		expect(result.content).toBe('[r] noted');
		// First-turn tools list passed to the LLM must only include `echo`.
		const turn1 = llm.calls[0];
		expect(turn1.tools?.map((t) => t.name).sort()).toEqual(['echo']);
		// And the banned call gets a "not available" tool_result.
		const toolResultMsg = llm.calls[1].messages.find((m) => m.role === 'tool');
		expect(JSON.stringify(toolResultMsg)).toContain('not available');
	});

	it('returns an error when the sub-agent does not exist', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
				routeLLM: async () => new ScriptedLLM([]),
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, { model: 'fake-model', prompt: 'x', subagent_type: 'unknown' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('Unknown sub-agent');
	});

	it('returns an error when the sub-agent exhausts its iteration budget', async () => {
		await createSubAgent(env, { description: 'd', maxIterations: 1, name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([[{ id: 'tc-1', input: { text: 'a' }, name: 'echo', type: 'tool_call' }, { type: 'done' }]]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry().register(echoTool),
				defaultModel: 'fake-model',
				routeLLM: async () => llm,
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, { model: 'fake-model', prompt: 'loop', subagent_type: 'r' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('exhausted');
	});

	it('surfaces provider errors from the inner LLM', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const llm = new ScriptedLLM([[{ message: 'boom', type: 'error' }]]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'fake-model',
				routeLLM: async () => llm,
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, { model: 'fake-model', prompt: 'x', subagent_type: 'r' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('boom');
	});

	it('runs the sub-agent on the model the caller supplied', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const seen: string[] = [];
		const llm = new ScriptedLLM([[{ delta: 'ok', type: 'text_delta' }, { type: 'done' }]]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'parent-model',
				routeLLM: async (_env, _globalId) => {
					seen.push(_globalId);
					return llm;
				},
			},
			list,
		);
		assertDefined(tool);
		await tool.execute(ctx, { model: 'caller-chosen', prompt: 'x', subagent_type: 'r' });
		expect(seen).toEqual(['caller-chosen']);
	});

	it('caller model overrides the sub-agent configured model', async () => {
		await createSubAgent(env, { description: 'd', model: 'configured-model', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const seen: string[] = [];
		const llm = new ScriptedLLM([[{ delta: 'ok', type: 'text_delta' }, { type: 'done' }]]);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'parent-model',
				routeLLM: async (_env, _globalId) => {
					seen.push(_globalId);
					return llm;
				},
			},
			list,
		);
		assertDefined(tool);
		await tool.execute(ctx, { model: 'caller-chosen', prompt: 'x', subagent_type: 'r' });
		expect(seen).toEqual(['caller-chosen']);
	});

	it('returns an error when the caller omits the model argument', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'parent-model',
				routeLLM: async () => new ScriptedLLM([]),
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, { prompt: 'x', subagent_type: 'r' });
		expect(result.isError).toBe(true);
		// Either zod's "Required" or the explicit empty-string follow-up — both
		// indicate the model argument was missing or blank.
		expect(result.content).toMatch(/model/);
	});

	it('rejects models outside the operator-curated list when one is configured', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const tool = createAgentTool(
			{
				availableModelGlobalIds: ['model-a', 'model-b'],
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'parent-model',
				routeLLM: async () => new ScriptedLLM([]),
			},
			list,
		);
		assertDefined(tool);
		const result = await tool.execute(ctx, {
			model: 'model-c',
			prompt: 'x',
			subagent_type: 'r',
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain('not in the user');
	});

	it('exposes the curated model slugs via the input schema enum', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const tool = createAgentTool(
			{
				availableModelGlobalIds: ['model-a', 'model-b'],
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'parent-model',
			},
			list,
		);
		assertDefined(tool);
		const schema = tool.definition.inputSchema as {
			properties: { model: { enum?: string[] } };
			required: string[];
		};
		expect(schema.properties.model.enum).toEqual(['model-a', 'model-b']);
		expect(schema.required).toContain('model');
	});

	it('omits the enum when no curated list is configured (any slug allowed)', async () => {
		await createSubAgent(env, { description: 'd', name: 'r', systemPrompt: 'sp' });
		const list = await (await import('../sub_agents')).listSubAgents(env);
		const tool = createAgentTool(
			{
				buildInnerToolRegistry: async () => new ToolRegistry(),
				defaultModel: 'parent-model',
			},
			list,
		);
		assertDefined(tool);
		const schema = tool.definition.inputSchema as { properties: { model: { enum?: string[] } } };
		expect(schema.properties.model.enum).toBeUndefined();
	});
});
