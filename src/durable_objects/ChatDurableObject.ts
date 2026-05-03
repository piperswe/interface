import { DurableObject } from 'cloudflare:workers';
import WorkersAILLM from '../llm/WorkersAILLM';

export default class ChatDurableObject extends DurableObject<Env> {
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * The Durable Object exposes an RPC method sayHello which will be invoked when a Durable
	 *  Object instance receives a request from a Worker via the same method invocation on the stub
	 *
	 * @param name - The name provided to a Durable Object instance from a Worker
	 * @returns The greeting to be sent back to the Worker
	 */
	async sayHello(name: string): Promise<string> {
		const llm = new WorkersAILLM(this.env.AI, 'anthropic/claude-haiku-4.5', 'workers-ai', 'default');
		const result = await llm.chatCompletions({
			messages: [{ role: 'user', content: 'What is the origin of the phrase Hello, World' }],
			max_tokens: 64_000,
			tools: [
				{
					name: 'get_hello_world_info',
					description: 'Get information about the origin of the phrase Hello, World',
					input_schema: {
						type: 'object',
					},
				},
				{
					name: 'get_hello_world_info_page_2',
					description: 'Get information about the origin of the phrase Hello, World (page 2)',
					input_schema: {
						type: 'object',
					},
				},
			],
		});
		return JSON.stringify(result, null, 4);
	}
}
