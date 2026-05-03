import { DurableObject } from 'cloudflare:workers';
import { OpenRouter } from '@openrouter/sdk';
import { OpenRouterLLM } from '../llm/OpenRouterLLM';
import LLM from '../llm/LLM';

export default class ChatDurableObject extends DurableObject<Env> {
	#model: LLM;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const client = new OpenRouter({ apiKey: env.OPENROUTER_KEY });
		this.#model = new OpenRouterLLM(client, 'openrouter/free:nitro', 'openrouter');
	}

	async sayHello(name: string): Promise<ReadableStream> {
		const model = this.#model;
		return new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const resultStream = model.chatCompletionsStream({
					messages: [{ role: 'user', content: 'What is the origin of the phrase Hello, World' }],
					// tools: [
					// 	{
					// 		type: 'function',
					// 		function: {
					// 			name: 'get_hello_world_info',
					// 			description: 'Get information about the origin of the phrase Hello, World',
					// 		},
					// 	},
					// 	{
					// 		type: 'function',
					// 		function: {
					// 			name: 'get_hello_world_info_page_2',
					// 			description: 'Get information about the origin of the phrase Hello, World (page 2)',
					// 		},
					// 	},
					// ],
				});
				for await (const chunk of resultStream) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				}
				controller.close();
			},
		});
	}
}
