import type { ChatStreamChunk, ChatUsage, GenerationResponseData } from '@openrouter/sdk/esm/models';
import { fmtCost, fmtMs, fmtNumber, fmtThroughput } from './formatters';

export interface MetaSnapshot {
	startedAt: number;
	firstTokenAt: number;
	lastChunk: ChatStreamChunk | null;
	usage: ChatUsage | null;
	generation: GenerationResponseData | null;
}

export interface MetaPanel {
	render(snapshot: MetaSnapshot): void;
	hide(): void;
}

export function createMetaPanel(container: HTMLElement): MetaPanel {
	const dl = document.createElement('dl');

	const addRow = (label: string): HTMLElement => {
		const dt = document.createElement('dt');
		dt.textContent = label;
		const dd = document.createElement('dd');
		dd.textContent = '—';
		dl.appendChild(dt);
		dl.appendChild(dd);
		return dd;
	};

	const fields = {
		model: addRow('Model'),
		id: addRow('ID'),
		serviceTier: addRow('Service tier'),
		promptTokens: addRow('Prompt tokens'),
		completionTokens: addRow('Completion tokens'),
		totalTokens: addRow('Total tokens'),
		cachedTokens: addRow('Cached tokens'),
		reasoningTokens: addRow('Reasoning tokens'),
		cost: addRow('Cost'),
		ttft: addRow('Time to first token'),
		total: addRow('Total time'),
		throughput: addRow('Throughput'),
	};

	const heading = document.createElement('h2');
	heading.textContent = 'Request metadata';
	container.replaceChildren();
	container.appendChild(heading);
	container.appendChild(dl);
	container.style.display = 'none';

	return {
		hide() {
			container.style.display = 'none';
		},
		render({ startedAt, firstTokenAt, lastChunk, usage, generation }: MetaSnapshot) {
			const ttftMs = firstTokenAt && startedAt ? firstTokenAt - startedAt : 0;

			fields.model.textContent = generation?.model ?? lastChunk?.model ?? '—';
			fields.id.textContent = lastChunk?.id ?? '—';
			fields.serviceTier.textContent = lastChunk?.serviceTier ?? '—';
			fields.promptTokens.textContent = fmtNumber(generation?.tokensPrompt ?? usage?.promptTokens);
			fields.completionTokens.textContent = fmtNumber(generation?.tokensCompletion ?? usage?.completionTokens);
			fields.totalTokens.textContent = fmtNumber(usage?.totalTokens);
			fields.cachedTokens.textContent = fmtNumber(generation?.nativeTokensCached ?? usage?.promptTokensDetails?.cachedTokens);
			fields.reasoningTokens.textContent = fmtNumber(
				generation?.nativeTokensReasoning ?? usage?.completionTokensDetails?.reasoningTokens,
			);
			fields.cost.textContent = fmtCost(generation?.totalCost ?? usage?.cost);
			fields.ttft.textContent = fmtMs(ttftMs);
			fields.total.textContent = fmtMs(generation?.latency ?? 0);
			fields.throughput.textContent = fmtThroughput(generation?.tokensCompletion ?? undefined, generation?.generationTime ?? 0);

			container.style.display = 'block';
		},
	};
}
