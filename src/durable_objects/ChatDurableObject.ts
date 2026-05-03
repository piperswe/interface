import { DurableObject } from 'cloudflare:workers';
import { OpenRouter } from '@openrouter/sdk';
import { OpenRouterLLM } from '../llm/OpenRouterLLM';
import LLM from '../llm/LLM';

const DEFAULT_MODEL = 'openai/gpt-5.5';

export default class ChatDurableObject extends DurableObject<Env> {
	#client: OpenRouter;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#client = new OpenRouter({ apiKey: env.OPENROUTER_KEY });
	}

	async ask(question: string, modelId?: string): Promise<ReadableStream> {
		const model: LLM = new OpenRouterLLM(this.#client, modelId || DEFAULT_MODEL, 'openrouter');
		return new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const resultStream = model.chatCompletionsStream({
					messages: [{ role: 'user', content: question }],
				});
				for await (const chunk of resultStream) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				}
				controller.close();
			},
		});
	}
}
