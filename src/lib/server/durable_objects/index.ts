// Typed accessor for the conversation Durable Object. `wrangler types` can't
// reach into the SvelteKit-bundled worker file to type the binding's DO
// class, so we cast here in one place. All callers go through this helper.

import type ConversationDurableObject from './ConversationDurableObject';
import type SchedulerDurableObject from './SchedulerDurableObject';

export type ConversationStub = DurableObjectStub<ConversationDurableObject>;

export function getConversationStub(env: Env, id: string): ConversationStub {
	const ns = env.CONVERSATION_DURABLE_OBJECT as unknown as DurableObjectNamespace<ConversationDurableObject>;
	return ns.getByName(id);
}

export type SchedulerStub = DurableObjectStub<SchedulerDurableObject>;

// Singleton scheduler. One DO id is enough — all schedule state lives in D1.
export function getSchedulerStub(env: Env): SchedulerStub {
	const ns = (env as unknown as { SCHEDULER_DURABLE_OBJECT?: DurableObjectNamespace<SchedulerDurableObject> })
		.SCHEDULER_DURABLE_OBJECT;
	if (!ns) {
		throw new Error('SCHEDULER_DURABLE_OBJECT binding is not configured');
	}
	return ns.getByName('singleton');
}
