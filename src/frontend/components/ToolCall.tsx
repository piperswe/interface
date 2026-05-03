import type { ToolCallRecord, ToolResultRecord } from '../../types/conversation';

export function ToolCallCard({
	call,
	result,
	defaultOpen = false,
	nested = false,
}: {
	call: ToolCallRecord;
	result?: ToolResultRecord;
	defaultOpen?: boolean;
	nested?: boolean;
}) {
	const pending = !result;
	const open = pending || defaultOpen;
	return (
		<details className={`tool-call${nested ? ' nested' : ''}`} data-tool-name={call.name} open={open}>
			<summary>
				<span className="tool-call-name">{call.name}</span>
				{pending ? (
					<span className="tool-call-status pending">
						running<span className="streaming-indicator" aria-hidden="true">●</span>
					</span>
				) : result.isError ? (
					<span className="tool-call-status error">error</span>
				) : (
					<span className="tool-call-status ok">done</span>
				)}
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
}
