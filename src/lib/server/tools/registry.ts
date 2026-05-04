import type { ToolDefinition } from '../llm/LLM';

// Result of a tool execution. The string `content` flows back into the next
// LLM turn as a tool_result block; structured `citations` and `artifacts` are
// surfaced to the UI separately by the tool execution loop.
export type ToolCitation = {
	url: string;
	title: string;
	snippet?: string;
};

export type ToolArtifactSpec = {
	type: 'code' | 'markdown';
	name?: string;
	language?: string;
	content: string;
};

export type ToolExecutionResult = {
	content: string;
	isError?: boolean;
	citations?: ToolCitation[];
	artifacts?: ToolArtifactSpec[];
};

export type ToolContext = {
	env: Env;
	conversationId: string;
	assistantMessageId: string;
	signal?: AbortSignal;
	emitToolOutput?: (chunk: string) => void;
};

export interface Tool {
	readonly definition: ToolDefinition;
	execute(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult>;
}

// Registry for tools available within a single generation. Tools are resolved
// by name; execution is dispatched to the matching Tool's execute().
export class ToolRegistry {
	#tools = new Map<string, Tool>();

	register(tool: Tool): this {
		this.#tools.set(tool.definition.name, tool);
		return this;
	}

	has(name: string): boolean {
		return this.#tools.has(name);
	}

	get(name: string): Tool | undefined {
		return this.#tools.get(name);
	}

	definitions(): ToolDefinition[] {
		return Array.from(this.#tools.values()).map((t) => t.definition);
	}

	async execute(ctx: ToolContext, name: string, input: unknown): Promise<ToolExecutionResult> {
		const tool = this.#tools.get(name);
		if (!tool) {
			return { content: `Unknown tool: ${name}`, isError: true };
		}
		try {
			return await tool.execute(ctx, input);
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
			};
		}
	}
}
