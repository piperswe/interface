import type { MetaSnapshot } from '../../types/conversation';
import { fmtCost, fmtMs, fmtNumber, fmtThroughput } from '../formatters';

export function MetaPanel({ snapshot }: { snapshot: MetaSnapshot | null }) {
	if (!snapshot) return null;

	const { startedAt, firstTokenAt, lastChunk, usage, generation } = snapshot;
	const ttftMs = firstTokenAt && startedAt ? firstTokenAt - startedAt : 0;

	return (
		<details className="meta-panel">
			<summary aria-label="Request metadata" title="Request metadata">
				<span className="meta-panel-icon" aria-hidden="true">
					ⓘ
				</span>
			</summary>
			<dl>
				<dt>Model</dt>
				<dd>{generation?.model ?? lastChunk?.model ?? '—'}</dd>
				<dt>ID</dt>
				<dd>{lastChunk?.id ?? '—'}</dd>
				<dt>Service tier</dt>
				<dd>{lastChunk?.serviceTier ?? '—'}</dd>
				<dt>Prompt tokens</dt>
				<dd>{fmtNumber(generation?.tokensPrompt ?? usage?.promptTokens)}</dd>
				<dt>Completion tokens</dt>
				<dd>{fmtNumber(generation?.tokensCompletion ?? usage?.completionTokens)}</dd>
				<dt>Total tokens</dt>
				<dd>{fmtNumber(usage?.totalTokens)}</dd>
				<dt>Cached tokens</dt>
				<dd>{fmtNumber(generation?.nativeTokensCached ?? usage?.promptTokensDetails?.cachedTokens)}</dd>
				<dt>Reasoning tokens</dt>
				<dd>{fmtNumber(generation?.nativeTokensReasoning ?? usage?.completionTokensDetails?.reasoningTokens)}</dd>
				<dt>Cost</dt>
				<dd>{fmtCost(generation?.totalCost ?? usage?.cost)}</dd>
				<dt>Time to first token</dt>
				<dd>{fmtMs(ttftMs)}</dd>
				<dt>Total time</dt>
				<dd>{fmtMs(generation?.latency ?? 0)}</dd>
				<dt>Throughput</dt>
				<dd>{fmtThroughput(generation?.tokensCompletion ?? undefined, generation?.generationTime ?? 0)}</dd>
			</dl>
		</details>
	);
}
