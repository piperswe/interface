import type { MessagePart, MessageRow, ThinkingPart, ToolResultPart, ToolUsePart } from '../../types/conversation';
import { Artifact } from './Artifact';
import { MetaPanel } from './MetaPanel';
import { ToolCallCard } from './ToolCall';

function TextPartView({ part }: { part: { text: string; textHtml?: string } }) {
	if (typeof part.textHtml === 'string' && part.textHtml.length > 0) {
		return <div className="content" dangerouslySetInnerHTML={{ __html: part.textHtml }} />;
	}
	return (
		<div className="content" style={{ whiteSpace: 'pre-wrap' }}>
			{part.text}
		</div>
	);
}

function ThinkingPartView({ part, streaming, nested }: { part: ThinkingPart; streaming: boolean; nested?: boolean }) {
	const showHtml = typeof part.textHtml === 'string' && part.textHtml.length > 0;
	return (
		<details className={`thinking${nested ? ' nested' : ''}`} open={streaming}>
			<summary>
				<span className="thinking-label">Thinking</span>
				{streaming ? <span className="streaming-indicator" aria-hidden="true">●</span> : null}
			</summary>
			{showHtml ? (
				<div className="thinking-body" dangerouslySetInnerHTML={{ __html: part.textHtml as string }} />
			) : (
				<div className="thinking-body" style={{ whiteSpace: 'pre-wrap' }}>
					{part.text}
				</div>
			)}
		</details>
	);
}

// Check whether a part type is "output" (user-visible text) or internal work.
const isOutput = (part: MessagePart) => part.type === 'text' || part.type === 'info';

function renderPartInner(
	part: MessagePart,
	index: number,
	allParts: MessagePart[],
	streaming: boolean,
	nested: boolean,
	resultsById: Map<string, ToolResultPart>,
): React.ReactNode {
	if (part.type === 'text') {
		if (!part.text) return null;
		return <TextPartView key={`text-${index}`} part={part} />;
	}
	if (part.type === 'thinking') {
		if (!part.text) return null;
		const isCurrent = streaming && index === allParts.length - 1;
		return <ThinkingPartView key={`think-${index}`} part={part} streaming={isCurrent} nested={nested} />;
	}
	if (part.type === 'info') {
		return (
			<div key={`info-${index}`} className="info-part">
				<span className="info-part-icon">ℹ</span>
				{part.text}
			</div>
		);
	}
	if (part.type === 'tool_use') {
		const use = part as ToolUsePart;
		const result = resultsById.get(use.id);
		return (
			<ToolCallCard
				key={`tool-${use.id}`}
				call={{ id: use.id, name: use.name, input: use.input }}
				result={result ? { toolUseId: result.toolUseId, content: result.content, isError: result.isError } : undefined}
				defaultOpen={streaming && !result}
				nested={nested}
			/>
		);
	}
	return null;
}

// Walk parts and group consecutive non-output parts (thinking, tool_use)
// into a single collapsible bundle. Text parts stay visible at the top
// level. Each part inside the bundle remains individually collapsible.
function renderParts(parts: MessagePart[], streaming: boolean): React.ReactNode[] {
	const resultsById = new Map<string, ToolResultPart>();
	for (const p of parts) {
		if (p.type === 'tool_result') resultsById.set(p.toolUseId, p);
	}

	// First, build groups: text parts are standalone, consecutive
	// non-output parts are bundled together.
	const nodes: React.ReactNode[] = [];
	let bundle: Array<{ part: MessagePart; index: number }> = [];

	const flushBundle = () => {
		if (bundle.length === 0) return;
		if (bundle.length === 1) {
			// Single non-output part — no wrapper needed
			const { part, index } = bundle[0];
			nodes.push(renderPartInner(part, index, parts, streaming, false, resultsById));
		} else {
			// 2+ non-output parts — wrap in a collapsible bundle
			const hasActive = bundle.some(({ part, index }) => {
				if (part.type === 'thinking') return streaming && index === parts.length - 1;
				if (part.type === 'tool_use') {
					const result = resultsById.get((part as ToolUsePart).id);
					return streaming && !result;
				}
				return false;
			});
			const key = `bundle-${bundle[0].index}-${bundle[bundle.length - 1].index}`;
			nodes.push(
				<details key={key} className="work-bundle" open={hasActive}>
					<summary>
						<span className="work-bundle-label">
							{bundle.some((b) => b.part.type === 'tool_use') ? 'Tools & thinking' : 'Thinking'}
						</span>
						{hasActive && <span className="streaming-indicator" aria-hidden="true">●</span>}
					</summary>
					<div className="work-bundle-body">
						{bundle.map(({ part, index }) =>
							renderPartInner(part, index, parts, streaming, true, resultsById),
						)}
					</div>
				</details>,
			);
		}
		bundle = [];
	};

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (isOutput(part)) {
			flushBundle();
			if (part.type === 'text' && !part.text) continue;
			nodes.push(renderPartInner(part, i, parts, streaming, false, resultsById));
		} else {
			bundle.push({ part, index: i });
		}
	}
	flushBundle();
	return nodes;
}

export function Message({ message }: { message: MessageRow }) {
	const isAssistant = message.role === 'assistant';
	const isStreaming = message.status === 'streaming';
	const artifacts = message.artifacts ?? [];
	const parts = message.parts;
	const hasParts = isAssistant && Array.isArray(parts) && parts.length > 0;
	// Fallback content path (legacy / streaming pre-first-token / user messages):
	// pre-rendered markdown HTML if present, else plain text. Used when the
	// `parts` timeline is empty.
	const showHtml = isAssistant && typeof message.contentHtml === 'string' && message.contentHtml.length > 0;
	return (
		<div className="message" data-message-id={message.id} data-role={message.role} data-status={message.status}>
			<div className="role">
				{message.role}
				{message.model ? ` · ${message.model}` : ''}
				{isStreaming ? <span className="streaming-indicator" aria-label="streaming">●</span> : null}
			</div>
			{hasParts ? (
				renderParts(parts as MessagePart[], isStreaming)
			) : showHtml ? (
				<div className="content" dangerouslySetInnerHTML={{ __html: message.contentHtml as string }} />
			) : (
				<div className="content" style={{ whiteSpace: 'pre-wrap' }}>
					{message.content}
				</div>
			)}
			{artifacts.length > 0 ? (
				<div className="artifacts">
					{artifacts.map((a) => (
						<Artifact key={a.id} artifact={a} />
					))}
				</div>
			) : null}
			{message.status === 'error' && message.error ? <div className="error">{message.error}</div> : null}
			{isStreaming ? <div className="message-spinner" aria-label="Generating response…"><span className="spinner" /></div> : null}
			{isAssistant && !isStreaming ? <MetaPanel snapshot={message.meta} /> : null}
		</div>
	);
}
