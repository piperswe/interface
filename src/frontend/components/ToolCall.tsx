import type { ToolCallRecord, ToolResultRecord } from '../../types/conversation';

export function ToolCallList({
	toolCalls,
	toolResults,
}: {
	toolCalls: ToolCallRecord[];
	toolResults: ToolResultRecord[];
}) {
	if (toolCalls.length === 0) return null;
	const resultsByToolUseId = new Map<string, ToolResultRecord>();
	for (const r of toolResults) resultsByToolUseId.set(r.toolUseId, r);

	return (
		<div className="tool-calls">
			{toolCalls.map((call) => {
				const result = resultsByToolUseId.get(call.id);
				return (
					<details key={call.id} className="tool-call" data-tool-name={call.name}>
						<summary>
							<span className="tool-call-name">{call.name}</span>
							{result?.isError ? <span className="tool-call-status error">error</span> : null}
						</summary>
						<div className="tool-call-body">
							<div className="tool-call-input">
								<div className="tool-call-label">Input</div>
								<pre>
									<code>{JSON.stringify(call.input ?? {}, null, 2)}</code>
								</pre>
							</div>
							{result ? (
								<div className="tool-call-result">
									<div className="tool-call-label">Result</div>
									<pre>
										<code>{result.content}</code>
									</pre>
								</div>
							) : (
								<div className="tool-call-result pending">running…</div>
							)}
						</div>
					</details>
				);
			})}
		</div>
	);
}
