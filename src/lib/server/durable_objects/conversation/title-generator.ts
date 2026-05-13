import { now as nowMs } from '../../clock';
import type { ChatRequest, StreamEvent } from '../../llm/LLM';
import { buildGlobalModelId } from '../../providers/types';
import { indexTitle as indexSearchTitle } from '../../search';
import { getSetting } from '../../settings';
import type { ConversationContext } from './tool-registry-builder';

const TITLE_MAX = 60;

type RouteLLM = (
	globalId: string,
	opts?: { purpose?: 'main' | 'title' },
) => Promise<{ model: string; providerID: string; chat(req: ChatRequest): AsyncIterable<StreamEvent> }>;

// Run the title-generator LLM, normalize its output, and persist to D1.
// `onlyIfDefault` guards the auto-generated path so a user-edited title
// isn't clobbered by a slow waitUntil() catching up. The caller passes
// false when the user explicitly asked for a refresh.
export async function writeTitle(
	env: Env,
	conversationId: string,
	input: string,
	opts: { systemPrompt: string; onlyIfDefault: boolean },
	deps: { routeLLM: RouteLLM; getContext: () => Promise<ConversationContext> },
): Promise<void> {
	const collapsed = input.replace(/\s+/g, ' ').trim();
	// Pick the configured title model, or fall back to the first available model.
	// Use the cached models list rather than hitting D1 again.
	const context = await deps.getContext();
	const globalIds = context.allModels.map((m) => buildGlobalModelId(m.providerId, m.id));
	const configuredTitleModel = await getSetting(env, 'title_model');
	const titleModel = configuredTitleModel && globalIds.includes(configuredTitleModel) ? configuredTitleModel : globalIds[0];
	if (!titleModel) return; // No models configured, skip title generation

	let title: string;
	try {
		const llm = await deps.routeLLM(titleModel, { purpose: 'title' });
		let buf = '';
		for await (const ev of llm.chat({
			maxTokens: 1024,
			messages: [
				{ content: opts.systemPrompt, role: 'system' },
				{ content: collapsed, role: 'user' },
			],
			temperature: 0.5,
		})) {
			if (ev.type === 'text_delta') buf += ev.delta;
			if (ev.type === 'error') throw new Error(ev.message);
		}
		// Collapse newlines/whitespace so a multi-line title doesn't break the
		// sidebar's single-line layout or downstream consumers that expect a
		// flat string. The LLM is told to reply with just the title; this is
		// defensive against models that emit a leading "Title: ..." preamble
		// or trailing reasoning.
		title = buf
			.replace(/[\r\n]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/^"|"$/g, '')
			.slice(0, TITLE_MAX);
		if (!title) throw new Error('empty title from LLM');
	} catch {
		title = collapsed.length <= TITLE_MAX ? collapsed : `${collapsed.slice(0, TITLE_MAX).trimEnd()}…`;
	}
	const sql = opts.onlyIfDefault
		? `UPDATE conversations SET title = CASE WHEN title = 'New conversation' THEN ? ELSE title END WHERE id = ?`
		: 'UPDATE conversations SET title = ? WHERE id = ?';
	await env.DB.prepare(sql).bind(title, conversationId).run();
	// Refresh the FTS title row to match what the conversations table now
	// holds. Read it back so `onlyIfDefault` no-ops keep their original
	// title indexed correctly.
	const row = await env.DB.prepare('SELECT title FROM conversations WHERE id = ?').bind(conversationId).first<{ title: string }>();
	if (row) await indexSearchTitle(env, conversationId, row.title, nowMs());
}

export const TITLE_GEN_SYSTEM_PROMPT =
	'You are a title generator. Given the user message, generate a short, clear, descriptive title (2-6 words) that summarises its topic or intent. Reply with the title only — no quotes, no explanation.';

export const TITLE_REGEN_SYSTEM_PROMPT =
	'You are a title generator. Given a conversation transcript, generate a short, clear, descriptive title (2-6 words) that summarises the overall topic or intent. Reply with the title only — no quotes, no explanation.';
