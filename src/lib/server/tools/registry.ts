import type { ToolDefinition, ToolResultBlock } from '../llm/LLM';

// Result of a tool execution. The `content` flows back into the next LLM
// turn as a tool_result block; structured `citations` and `artifacts` are
// surfaced to the UI separately by the tool execution loop. Most tools
// return a string; multimodal tools (e.g. sandbox_load_image) return an
// array of text/image blocks.
export type ToolCitation = {
	url: string;
	title: string;
	snippet?: string;
};

export type ToolArtifactSpec = {
	type: 'code' | 'markdown' | 'html' | 'svg' | 'mermaid';
	name?: string;
	language?: string;
	content: string;
};

// Discriminator for the cause of a tool failure. The string is also part of
// the failure `content` so the model sees it; callers can branch on this when
// deciding whether to retry. Keep the set small and stable.
export type ToolErrorCode = 'not_found' | 'execution_failure' | 'invalid_input';

export type ToolExecutionResult = {
	content: string | ToolResultBlock[];
	isError?: boolean;
	errorCode?: ToolErrorCode;
	citations?: ToolCitation[];
	artifacts?: ToolArtifactSpec[];
};

export type ToolContext = {
	env: Env;
	conversationId: string;
	assistantMessageId: string;
	// The model id active for the current iteration. Reflects mid-turn
	// `switch_model` calls — tools that need to know the live model
	// (e.g. capability-gated tools) should read this, not the turn-start
	// model.
	modelId: string;
	signal?: AbortSignal;
	emitToolOutput?: (chunk: string) => void;
	switchModel?: (newModelId: string) => void;
	// Register a citation and get back its stable, 1-based global index for
	// the current turn. Deduped by URL, so calling twice for the same URL
	// returns the same index. Tools that surface citations should use this
	// to number entries in their result text (`[N]`); the agent learns to
	// reference those same numbers inline (`The capital is Paris [1].`),
	// and the rendered markdown turns each `[N]` into a link to the
	// Sources entry. Tools that don't call this can fall back to returning
	// `result.citations`, in which case those entries are appended to the
	// turn's citation list but no inline markers will resolve.
	registerCitation?: (citation: ToolCitation) => number;
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
			return { content: `Unknown tool: ${name}`, errorCode: 'not_found', isError: true };
		}
		try {
			return await tool.execute(ctx, input);
		} catch (e) {
			return {
				content: e instanceof Error ? e.message : String(e),
				errorCode: 'execution_failure',
				isError: true,
			};
		}
	}
}
