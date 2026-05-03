// Typed accessor for the conversation Durable Object. `wrangler types` can't
// reach into the SvelteKit-bundled worker file to type the binding's DO
// class, so we cast here in one place. All callers go through this helper.

import type ConversationDurableObject from './ConversationDurableObject';

export type ConversationStub = DurableObjectStub<ConversationDurableObject>;

export function getConversationStub(env: Env, id: string): ConversationStub {
	const ns = env.CONVERSATION_DURABLE_OBJECT as unknown as DurableObjectNamespace<ConversationDurableObject>;
	return ns.getByName(id);
}
