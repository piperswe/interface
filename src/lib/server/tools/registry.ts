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

// Discriminator for the cause of a tool failure. The string is also part of
// the failure `content` so the model sees it; callers can branch on this when
// deciding whether to retry. Keep the set small and stable.
export type ToolErrorCode = 'not_found' | 'execution_failure' | 'invalid_input';

export type ToolExecutionResult = {
	content: string;
	isError?: boolean;
	errorCode?: ToolErrorCode;
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
			return { content: `Unknown tool: ${name}`, isError: true, errorCode: 'not_found' };
		}
		try {
			return await tool.execute(ctx, input);
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				isError: true,
				errorCode: 'execution_failure',
			};
		}
	}
}
